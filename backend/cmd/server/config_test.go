package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestSessionSecret(t *testing.T) {
	strong := strings.Repeat("k", minSecretBytes)
	if got, err := sessionSecret(strong, "release"); err != nil || string(got) != strong {
		t.Errorf("a strong secret: %q, %v", got, err)
	}
	if _, err := sessionSecret("", "release"); err == nil {
		t.Error("release mode started with no secret")
	}
	for _, mode := range []string{"release", "debug", ""} {
		if _, err := sessionSecret("too-short", mode); err == nil {
			t.Errorf("%q mode accepted a short secret", mode)
		}
	}
	a, err := sessionSecret("", "debug")
	if err != nil || len(a) != minSecretBytes {
		t.Fatalf("development key: %d bytes, %v", len(a), err)
	}
	b, _ := sessionSecret("", "debug")
	if bytes.Equal(a, b) {
		t.Error("two development keys matched: they should be random")
	}
}

func TestCheckRedirect(t *testing.T) {
	for _, good := range []string{"", "https://brew.example.com/api/auth/google/callback",
		"http://localhost:4200/api/calendar/callback", "http://127.0.0.1:5001/api/auth/google/callback"} {
		if err := checkRedirect(good); err != nil {
			t.Errorf("%q: %v", good, err)
		}
	}
	for _, bad := range []string{"http://brew.example.com/cb", "not a url", "ftp://localhost/cb", "//brew.example.com/cb",
		"http://localhost.evil.example/cb"} {
		if err := checkRedirect(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}

func TestParseProxies(t *testing.T) {
	got, err := parseProxies(" 10.0.0.0/8, 192.168.1.1 ,,2001:db8::/32")
	if err != nil || strings.Join(got, "|") != "10.0.0.0/8|192.168.1.1|2001:db8::/32" {
		t.Errorf("%v, %v", got, err)
	}
	if got, err := parseProxies(""); err != nil || got != nil {
		t.Errorf("empty: %v, %v", got, err)
	}
	if _, err := parseProxies("10.0.0.0/8,example.com"); err == nil {
		t.Error("a hostname was accepted")
	}
}
