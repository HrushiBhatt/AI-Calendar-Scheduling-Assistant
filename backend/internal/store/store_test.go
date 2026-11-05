package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

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
