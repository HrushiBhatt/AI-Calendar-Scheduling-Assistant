package plans

import (
	"context"
	"errors"
	"slices"
	"sort"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/planner"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// CacheFor is how long an identical planner input returns the stored plan instead of a new one.
const CacheFor = 10 * time.Minute

// Service runs the plan lifecycle.
type Service struct {
	DB      *gorm.DB
	Hub     *events.Hub
	Now     func() time.Time
	Latency *Latency // planner.Plan timings, for the latency claim
	// OnChange runs after blocks are accepted, moved or dropped. The dispatcher sets it to
	// wake up early, so a block accepted one minute out still gets its warning on time.
	OnChange func()
	// Calendar receives write-back work for accepted blocks; nil disables write-back.
	Calendar Writer
}

// Writer copies accepted blocks to the user's calendar (see calendar.Writer).
type Writer interface {
	Upsert(userID, blockID uint)
	Remove(userID, blockID uint)
}

func (s *Service) changed() {
	if s.OnChange != nil {
		s.OnChange()
	}
}

func New(db *gorm.DB, hub *events.Hub) *Service {
	return &Service{DB: db, Hub: hub, Now: time.Now, Latency: &Latency{}}
}

// View is a plan with its blocks, as the API returns it.
type View struct {
	store.Plan
	Blocks []store.ScheduledSession `json:"blocks"`
}

// Proposal is one request for a plan.
type Proposal struct {
	Args      Args
	Text      string // the user's words, when the request came from the assistant
	Source    string // store.SourceAssistant, SourceForm, SourceQuick or SourceConflict
	Narration string
	Replaces  []uint // conflicted blocks a reconciliation plan replaces
	// Prepared skips validation and input building: the caller already did both.
	Prepared *Prepared
}

// Prepared is a validated request turned into planner input.
type Prepared struct {
	User  store.User
	Loc   *time.Location
	Modes []planner.Mode
	Input planner.Input
	Hash  string
}

// Prepare validates args and builds the planner input for a user.
func (s *Service) Prepare(userID uint, args *Args, exclude []uint) (*Prepared, error) {
	var user store.User
	if err := s.DB.First(&user, userID).Error; err != nil {
		return nil, err
	}
	loc, err := user.Settings.Location()
	if err != nil {
		return nil, err
	}
	now := s.Now()
	modes, err := Modes(s.DB, userID, now)
	if err != nil {
		return nil, err
	}
	if err := args.Validate(s.DB, userID, modes, now, loc); err != nil {
		return nil, err
	}
	in, err := BuildInput(s.DB, user, loc, *args, now, modes, exclude)
	if err != nil {
		return nil, err
	}
	return &Prepared{User: user, Loc: loc, Modes: modes, Input: in, Hash: in.Hash()}, nil
}

// Propose plans and stores a proposal: a Plan and its blocks, all "proposed". An
// identical planner input within CacheFor returns the stored plan instead. A new
// proposal supersedes the user's previous one of the same kind.
func (s *Service) Propose(ctx context.Context, userID uint, p Proposal) (*View, error) {
	prep := p.Prepared
	if prep == nil {
		var err error
		if prep, err = s.Prepare(userID, &p.Args, p.Replaces); err != nil {
			return nil, err
		}
	}
	if cached, err := s.cached(userID, prep.Hash, p.Source); cached != nil || err != nil {
		return cached, err
	}
	started := time.Now()
	result, err := planner.Plan(prep.Input)
	s.Latency.Record(time.Since(started))
	if err != nil {
		return nil, err
	}
	from, to, err := Bounds(prep.Input.Window, prep.Loc)
	if err != nil {
		return nil, err
	}
	plan := store.Plan{
		UserID: userID, Status: store.PlanProposed, Source: p.Source, WindowStart: from.UTC(), WindowEnd: to.UTC(),
		Request: truncate(p.Text, 500), Rationale: truncate(p.Narration, 1200), InputHash: prep.Hash,
		Notes: result.Notes, Replaces: p.Replaces, CreatedAt: s.Now().UTC(), // the service's clock, which the cache reads
		AllowEvening: prep.Input.Request.AllowEvening, AllowWeekend: prep.Input.Request.AllowWeekend,
	}
	for _, u := range result.Unplaced {
		plan.Unplaced = append(plan.Unplaced, store.UnplacedTask{TaskID: u.TaskID, Task: u.Task, Wanted: u.Wanted, Placed: u.Placed, Reason: u.Reason})
	}
	view := &View{}
	err = s.DB.Transaction(func(tx *gorm.DB) error {
		// One live proposal at a time: asking again replaces the one on screen. A conflict
		// re-plan only replaces an earlier re-plan, never what the user is working on.
		q := tx.Model(&store.Plan{}).Where("user_id = ? AND status = ?", userID, store.PlanProposed)
		if p.Source == store.SourceConflict {
			q = q.Where("source = ?", store.SourceConflict)
		} else {
			q = q.Where("source <> ?", store.SourceConflict)
		}
		var stale []uint
		if err := q.Pluck("id", &stale).Error; err != nil {
			return err
		}
		if len(stale) > 0 {
			if err := tx.Model(&store.Plan{}).Where("id IN ?", stale).Update("status", store.PlanSuperseded).Error; err != nil {
				return err
			}
			if err := tx.Model(&store.ScheduledSession{}).Where("plan_id IN ? AND status = ?", stale, store.BlockProposed).
				Updates(map[string]any{"status": store.BlockRejected, "note": "superseded by a newer plan"}).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(&plan).Error; err != nil {
			return err
		}
		for _, b := range result.Blocks {
			block := store.ScheduledSession{
				UserID: userID, PlanID: plan.ID, TaskID: b.TaskID, NewTask: b.TaskID == nil && b.Task != "",
				Mode: b.Mode, StartsAt: b.StartsAt.UTC(), FocusMin: b.FocusMin, RestMin: b.RestMin,
				Intention: truncate(b.Task, 140), Status: store.BlockProposed, Explain: truncate(b.Explain, 300), Score: b.Score,
			}
			if err := tx.Create(&block).Error; err != nil {
				return err
			}
			view.Blocks = append(view.Blocks, block)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	view.Plan = plan
	if view.Blocks == nil {
		view.Blocks = []store.ScheduledSession{}
	}
	s.Hub.Publish(userID, events.Event{Type: "plan.proposed", Data: map[string]any{"plan_id": plan.ID}})
	return view, nil
}

// cached returns the user's live proposal with this input hash, if one was made recently.
func (s *Service) cached(userID uint, hash, source string) (*View, error) {
	var plan store.Plan
	q := s.DB.Where("user_id = ? AND input_hash = ? AND status = ? AND created_at > ?", userID, hash, store.PlanProposed, s.Now().Add(-CacheFor))
	if source == store.SourceConflict {
		q = q.Where("source = ?", store.SourceConflict)
	} else {
		q = q.Where("source <> ?", store.SourceConflict)
	}
	err := q.Order("id DESC").Limit(1).Find(&plan).Error
	if err != nil || plan.ID == 0 {
		return nil, err
	}
	return s.Get(userID, plan.ID)
}

// SetNarration stores the model's narration on a plan.
func (s *Service) SetNarration(planID uint, text string) error {
	return s.DB.Model(&store.Plan{}).Where("id = ?", planID).Update("rationale", truncate(text, 1200)).Error
}

// Get loads one of the user's plans with its blocks.
func (s *Service) Get(userID, planID uint) (*View, error) {
	var plan store.Plan
	if err := s.DB.Where("id = ? AND user_id = ?", planID, userID).First(&plan).Error; err != nil {
		return nil, err
	}
	view := &View{Plan: plan, Blocks: []store.ScheduledSession{}}
	return view, s.DB.Where("plan_id = ?", plan.ID).Order("starts_at, id").Find(&view.Blocks).Error
}

// Live returns the user's current proposals: the latest regular one and the latest
// conflict re-plan, either of which may be absent.
func (s *Service) Live(userID uint) ([]*View, error) {
	var plans []store.Plan
	if err := s.DB.Where("user_id = ? AND status = ?", userID, store.PlanProposed).Order("id DESC").Find(&plans).Error; err != nil {
		return nil, err
	}
	var out []*View
	seen := map[bool]bool{}
	for _, p := range plans {
		conflict := p.Source == store.SourceConflict
		if seen[conflict] {
			continue
		}
		seen[conflict] = true
		v, err := s.Get(userID, p.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

// ErrNotProposed means the plan was already accepted, rejected or superseded.
var ErrNotProposed = errors.New("that plan is no longer open")

func truncate(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// Latency keeps the most recent planner timings for p50/p99.
type Latency struct {
	mu      sync.Mutex
	samples []time.Duration
	next    int
}

const latencySamples = 1000

func (l *Latency) Record(d time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.samples) < latencySamples {
		l.samples = append(l.samples, d)
		return
	}
	l.samples[l.next] = d
	l.next = (l.next + 1) % latencySamples
}

// Percentiles returns p50 and p99 over the recorded samples, and how many there are.
func (l *Latency) Percentiles() (p50, p99 time.Duration, n int) {
	l.mu.Lock()
	sorted := slices.Clone(l.samples)
	l.mu.Unlock()
	if len(sorted) == 0 {
		return 0, 0, 0
	}
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	at := func(q float64) time.Duration { return sorted[min(len(sorted)-1, int(q*float64(len(sorted))))] }
	return at(0.50), at(0.99), len(sorted)
}
