package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
)

func TestSettingsMissingFieldsTakeDefaults(t *testing.T) {
	// An account saved before a field existed.
	var s Settings
	if err := json.Unmarshal([]byte(`{"sound":false,"tick":"clock"}`), &s); err != nil {
		t.Fatal(err)
	}
	if s.Sound || s.Tick != "clock" {
		t.Fatalf("saved values lost: %+v", s)
	}
	if !s.AutoBreak || !s.Breathe {
		t.Fatalf("defaults not applied: %+v", s)
	}
}

func TestOpenEnablesWALOnFiles(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	var timeout int
	db.Raw("PRAGMA journal_mode").Scan(&mode)
	db.Raw("PRAGMA busy_timeout").Scan(&timeout)
	if mode != "wal" || timeout != 5000 {
		t.Fatalf("journal_mode=%q busy_timeout=%d", mode, timeout)
	}
}

// Times are stored and compared as text, so every argument must be in UTC or a query
// near midnight compares the wrong way. The driver wrapper makes that true everywhere.
func TestTimeArgumentsCompareAsInstantsWhateverTheirZone(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	ny, _ := time.LoadLocation("America/New_York")
	tokyo, _ := time.LoadLocation("Asia/Tokyo")
	// 03:22 UTC on the 25th is 23:22 on the 24th in New York and 12:22 on the 25th in Tokyo.
	at := time.Date(2026, 10, 25, 3, 22, 0, 0, time.UTC)
	db.Create(&LoginSession{ID: "s", UserID: 1, ExpiresAt: at.In(tokyo)})

	var raw string
	db.Raw("SELECT expires_at || '' FROM login_sessions").Scan(&raw) // as text, not parsed back into a time
	if !strings.HasPrefix(raw, "2026-10-25 03:22:00") || !strings.HasSuffix(raw, "+00:00") {
		t.Fatalf("stored %q, want UTC", raw)
	}
	for _, now := range []time.Time{at.Add(time.Minute).In(ny), at.Add(time.Minute).In(tokyo), at.Add(time.Minute)} {
		var n int64
		db.Model(&LoginSession{}).Where("expires_at <= ?", now).Count(&n)
		if n != 1 {
			t.Errorf("expires_at <= %v matched %d rows, want 1", now, n)
		}
		db.Model(&LoginSession{}).Where("expires_at > ?", now).Count(&n)
		if n != 0 {
			t.Errorf("expires_at > %v matched %d rows, want 0", now, n)
		}
	}
	var back LoginSession
	db.First(&back)
	if !back.ExpiresAt.Equal(at) {
		t.Errorf("read back %v, want %v", back.ExpiresAt, at)
	}
}

func TestDatabaseFileIsPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "brew.db")
	// An existing, world-readable database gets tightened too.
	if err := os.WriteFile(path, nil, 0o644); err != nil { //nolint:gosec // the point of the test
		t.Fatal(err)
	}
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if sql, err := db.DB(); err == nil {
		t.Cleanup(func() { _ = sql.Close() })
	}
	if err := db.Create(&User{Email: "a@b.co", PasswordHash: []byte{}, Settings: DefaultSettings}).Error; err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{path, path + "-wal"} {
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o600 {
			t.Errorf("%s: mode %o, want 600", filepath.Base(name), mode)
		}
	}
}

func TestDatabaseLogsCarryNoValues(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	filter, ok := db.Logger.(gorm.ParamsFilter)
	if !ok {
		t.Fatal("the logger can't filter parameters")
	}
	if _, params := filter.ParamsFilter(t.Context(), "SELECT ?", "a-secret"); params != nil {
		t.Errorf("query values would be logged: %v", params)
	}
}
