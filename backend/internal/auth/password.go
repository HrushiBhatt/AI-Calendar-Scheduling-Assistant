package auth

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/trustelem/zxcvbn"
)

const (
	// MinPasswordLength favors length over composition rules, as NIST SP 800-63B advises:
	// a few unrelated words beat "P@ssw0rd!", and are easier to remember.
	MinPasswordLength = 12
	// MaxPasswordBytes is bcrypt's limit. It counts bytes, so an accented or emoji
	// password reaches it in fewer characters.
	MaxPasswordBytes = 72
	// minPasswordScore is zxcvbn's "safely unguessable" band: roughly 10^8 guesses or more,
	// which at bcrypt's speed outlasts an online attack and slows an offline one to years.
	minPasswordScore = 3
)

// ValidatePassword checks a new password. userInputs are words an attacker would try first
// for this account, such as the email and name. Existing passwords aren't re-checked at
// sign-in: this applies when one is chosen.
func ValidatePassword(password string, userInputs ...string) error {
	if utf8.RuneCountInString(password) < MinPasswordLength {
		return fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	}
	if len(password) > MaxPasswordBytes {
		return fmt.Errorf("password must be at most %d bytes (accents and emoji count as more than one)", MaxPasswordBytes)
	}
	inputs := []string{"brew", "focus", "brewfocus"}
	for _, in := range userInputs {
		for part := range strings.FieldsFuncSeq(strings.ToLower(in), func(r rune) bool { return r == '@' || r == '.' || r == ' ' }) {
			inputs = append(inputs, part)
		}
		inputs = append(inputs, in)
	}
	if zxcvbn.PasswordStrength(password, inputs).Score < minPasswordScore {
		return errors.New("that password is too easy to guess: a few unrelated words work well")
	}
	return nil
}
