package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

func TestSealedTokensRoundTripAndAreCiphertextAtRest(t *testing.T) {
	if err := SetSealKey(testKey); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = SetSealKey("") })
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}

	acct := CalendarAccount{UserID: 1, Provider: "google", ExternalID: "ada@example.com",
		AccessToken: []byte("ya29.secret-access"), RefreshToken: []byte("1//secret-refresh")}
	if err := db.Create(&acct).Error; err != nil {
		t.Fatal(err)
	}

	var raw struct{ AccessToken, RefreshToken []byte }
	db.Raw("SELECT access_token, refresh_token FROM calendar_accounts WHERE id = ?", acct.ID).Scan(&raw)
	if bytes.Contains(raw.AccessToken, []byte("secret")) || bytes.Contains(raw.RefreshToken, []byte("secret")) {
		t.Fatal("a token is stored in plain text")
	}
	if bytes.Equal(raw.AccessToken[:12], raw.RefreshToken[:12]) {
		t.Fatal("two fields share a nonce")
	}

	var got CalendarAccount
	if err := db.First(&got, acct.ID).Error; err != nil {
		t.Fatal(err)
	}
	if string(got.AccessToken) != "ya29.secret-access" || string(got.RefreshToken) != "1//secret-refresh" {
		t.Fatalf("decrypted to %q / %q", got.AccessToken, got.RefreshToken)
	}

	// A ciphertext moved to the other column must not open: the column name is bound in.
	db.Exec("UPDATE calendar_accounts SET refresh_token = access_token WHERE id = ?", acct.ID)
	if err := db.First(&got, acct.ID).Error; err == nil {
		t.Fatal("a swapped ciphertext decrypted")
	}
}

func TestSealedFieldsFailClosedWithoutTheRightKey(t *testing.T) {
	t.Cleanup(func() { _ = SetSealKey("") })
	_ = SetSealKey("")
	db, _ := Open(":memory:")
	err := db.Create(&CalendarAccount{UserID: 1, Provider: "google", ExternalID: "x", AccessToken: []byte("a"), RefreshToken: []byte("r")}).Error
	if !errors.Is(err, ErrNoSealKey) {
		t.Fatalf("writing without a key: %v, want ErrNoSealKey", err)
	}
	if err := db.Create(&CalendarAccount{UserID: 1, Provider: "demo", ExternalID: "demo", AccessToken: []byte{}, RefreshToken: []byte{}}).Error; err != nil {
		t.Fatalf("an account without tokens needs no key: %v", err)
	}

	_ = SetSealKey(testKey)
	acct := CalendarAccount{UserID: 1, Provider: "google", ExternalID: "x", AccessToken: []byte("ya29.plaintext"), RefreshToken: []byte("1//plaintext")}
	if err := db.Create(&acct).Error; err != nil {
		t.Fatal(err)
	}
	_ = SetSealKey(strings.Repeat("ff", 32))
	err = db.First(&CalendarAccount{}, acct.ID).Error
	if err == nil || strings.Contains(err.Error(), "plaintext") {
		t.Fatalf("reading with the wrong key: %v, want an error that carries no token", err)
	}
	if err := SetSealKey("not-hex"); err == nil {
		t.Fatal("a malformed key was accepted")
	}
}

func TestSettingsMissingFieldsTakeDefaults(t *testing.T) {
	// An account saved before the planning fields existed.
	var s Settings
	if err := json.Unmarshal([]byte(`{"sound":false,"tick":"clock"}`), &s); err != nil {
		t.Fatal(err)
	}
	if s.Sound || s.Tick != "clock" {
		t.Fatalf("saved values lost: %+v", s)
	}
	if s.WorkdayStart != "09:00" || s.MaxBlocksPerDay != 4 || !s.AssistantEnabled || s.ShareEventTitles {
		t.Fatalf("defaults not applied: %+v", s)
	}
}

func TestLoadZone(t *testing.T) {
	if _, err := LoadZone(""); !errors.Is(err, ErrNoTimeZone) {
		t.Fatalf("empty zone: %v", err)
	}
	for _, bad := range []string{"Local", "local", "Mars/Olympus", "../etc/passwd"} {
		if _, err := LoadZone(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if loc, err := LoadZone("America/Chicago"); err != nil || loc.String() != "America/Chicago" {
		t.Fatalf("valid zone: %v %v", loc, err)
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
	db.Create(&ScheduledSession{UserID: 1, PlanID: 1, Mode: "x", StartsAt: at.In(tokyo), FocusMin: 25, Status: BlockAccepted})

	var raw string
	db.Raw("SELECT starts_at || '' FROM scheduled_sessions").Scan(&raw) // as text, not parsed back into a time
	if !strings.HasPrefix(raw, "2026-10-25 03:22:00") || !strings.HasSuffix(raw, "+00:00") {
		t.Fatalf("stored %q, want UTC", raw)
	}
	for _, now := range []time.Time{at.Add(time.Minute).In(ny), at.Add(time.Minute).In(tokyo), at.Add(time.Minute)} {
		var n int64
		db.Model(&ScheduledSession{}).Where("starts_at <= ?", now).Count(&n)
		if n != 1 {
			t.Errorf("starts_at <= %v matched %d rows, want 1", now, n)
		}
		db.Model(&ScheduledSession{}).Where("starts_at > ?", now).Count(&n)
		if n != 0 {
			t.Errorf("starts_at > %v matched %d rows, want 0", now, n)
		}
	}
	var back ScheduledSession
	db.First(&back)
	if !back.StartsAt.Equal(at) {
		t.Errorf("read back %v, want %v", back.StartsAt, at)
	}
}
