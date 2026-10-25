package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/calendar"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

const maxScheduleRange = 31 * 24 * time.Hour

// eventView is a calendar event as the day timeline draws it.
type eventView struct {
	ID       uint      `json:"id"`
	Title    string    `json:"title"`
	StartsAt time.Time `json:"starts_at"`
	EndsAt   time.Time `json:"ends_at"`
	AllDay   bool      `json:"all_day"`
	Busy     bool      `json:"busy"`
}

// visibleBlocks are the scheduled statuses the timeline shows outside a plan review.
var visibleBlocks = []string{store.BlockAccepted, store.BlockStarted, store.BlockDone, store.BlockConflicted}

// schedule returns the user's calendar events plus their accepted focus blocks between
// ?from and ?to (YYYY-MM-DD days in the user's zone, or RFC 3339 times; default today).
func (h *handler) schedule(c *gin.Context) {
	uid := auth.UserID(c)
	user, loc, valid := h.userZone(c, uid)
	if !valid {
		return
	}
	from, to, err := parseRange(c.Query("from"), c.Query("to"), loc, time.Now())
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	rows, err := calendar.Events(h.DB, uid, from, to)
	if !ok(c, err) {
		return
	}
	events := make([]eventView, len(rows))
	for i, r := range rows {
		events[i] = eventView{ID: r.ID, Title: r.Title, StartsAt: r.StartsAt, EndsAt: r.EndsAt, AllDay: r.AllDay, Busy: r.Busy}
	}
	blocks := []store.ScheduledSession{}
	err = h.DB.Where("user_id = ? AND status IN ? AND starts_at < ? AND starts_at >= ?", uid, visibleBlocks, to, from.Add(-4*time.Hour)).
		Order("starts_at, id").Find(&blocks).Error
	if !ok(c, err) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"from": from, "to": to, "time_zone": user.Settings.TimeZone, "events": events, "blocks": blocks})
}

// userZone loads the signed-in user and their time zone, replying 400 if none is set.
func (h *handler) userZone(c *gin.Context, uid uint) (*store.User, *time.Location, bool) {
	var user store.User
	if !found(c, h.DB.First(&user, uid).Error) {
		return nil, nil, false
	}
	loc, err := user.Settings.Location()
	if err != nil {
		badRequest(c, err.Error())
		return nil, nil, false
	}
	return &user, loc, true
}

// parseRange reads a [from, to) range. Days are local days in loc, built with time.Date
// so a DST day is its real 23 or 25 hours long; "to" as a day is inclusive of that day.
func parseRange(fromRaw, toRaw string, loc *time.Location, now time.Time) (time.Time, time.Time, error) {
	local := now.In(loc)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	from, to := today, today.AddDate(0, 0, 1)
	var err error
	if fromRaw != "" {
		if from, _, err = parseInstant(fromRaw, loc); err != nil {
			return time.Time{}, time.Time{}, errors.New("from must be a YYYY-MM-DD day or an RFC 3339 time")
		}
		to = time.Date(from.In(loc).Year(), from.In(loc).Month(), from.In(loc).Day()+1, 0, 0, 0, 0, loc)
	}
	if toRaw != "" {
		var isDay bool
		if to, isDay, err = parseInstant(toRaw, loc); err != nil {
			return time.Time{}, time.Time{}, errors.New("to must be a YYYY-MM-DD day or an RFC 3339 time")
		}
		if isDay {
			to = to.AddDate(0, 0, 1) // through the end of that day
		}
	}
	if !to.After(from) {
		return time.Time{}, time.Time{}, errors.New("to must be after from")
	}
	if to.Sub(from) > maxScheduleRange {
		return time.Time{}, time.Time{}, errors.New("ask for at most 31 days at a time")
	}
	return from, to, nil
}

// parseInstant accepts a local day (midnight in loc) or an RFC 3339 time.
func parseInstant(raw string, loc *time.Location) (time.Time, bool, error) {
	if day, err := time.ParseInLocation(dayLayout, raw, loc); err == nil {
		return day, true, nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	return t, false, err
}
