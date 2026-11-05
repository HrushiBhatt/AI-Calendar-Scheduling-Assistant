package auth

import (
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

// The default must survive: tests lower Cost in their own process only.
func TestDefaultCost(t *testing.T) {
	if Cost != 12 {
		t.Fatalf("Cost = %d, want 12", Cost)
	}
}

func TestPasswordRoundTrip(t *testing.T) {
	Cost = bcrypt.MinCost
	defer func() { Cost = 12 }()
	hash, err := HashPassword("plum lantern gravity orbit")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(hash, "plum lantern gravity orbit") {
		t.Error("the right password was refused")
	}
	if CheckPassword(hash, "plum lantern gravity orbi") {
		t.Error("a wrong password was accepted")
	}
	for _, empty := range [][]byte{nil, {}} {
		if CheckPassword(empty, "") || CheckPassword(empty, "anything") {
			t.Error("an empty hash matched")
		}
	}
}

func TestValidatePassword(t *testing.T) {
	for _, good := range []string{"plum lantern gravity orbit", "correct horse battery", "Zk8#vQ2!mP9$xL4"} {
		if err := ValidatePassword(good); err != nil {
			t.Errorf("%q: %v", good, err)
		}
	}
	for password, want := range map[string]string{
		"short":                      "at least",
		strings.Repeat("ab cd ", 13): "at most",
		"password1234":               "too easy",
		"brewfocus2026":              "too easy",
		"111111111111":               "too easy",
	} {
		err := ValidatePassword(password)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", password, err, want)
		}
	}
	// A password built from the account's own details is easy for an attacker to try first.
	if err := ValidatePassword("ada.lovelace@example.com", "ada.lovelace@example.com", "Ada Lovelace"); err == nil {
		t.Error("the account's own email was accepted as its password")
	}
}
