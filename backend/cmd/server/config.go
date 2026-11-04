package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"net/netip"
	"net/url"
	"os"
	"strings"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
)

// minSecretBytes matches the HS256 key size: 32 random bytes, or 64 hex characters.
const minSecretBytes = 32

// config is the optional configuration. The app runs with none of it set.
type config struct {
	googleID, googleSecret string
	googleLoginRedirect    string   // enables "Sign in with Google"
	trustedProxies         []string // who may report a client's real IP
}

// loadConfig reads the environment and refuses settings that can't work, so a mistake shows
// up at startup rather than on someone's first sign-in.
func loadConfig() (*config, error) {
	c := &config{
		googleID:            os.Getenv("GOOGLE_CLIENT_ID"),
		googleSecret:        os.Getenv("GOOGLE_CLIENT_SECRET"),
		googleLoginRedirect: os.Getenv("GOOGLE_LOGIN_REDIRECT_URL"),
	}
	if (c.googleID == "") != (c.googleSecret == "") {
		return nil, errors.New("set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither")
	}
	if c.googleID == "" && c.googleLoginRedirect != "" {
		return nil, errors.New("GOOGLE_LOGIN_REDIRECT_URL needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET")
	}
	if err := checkRedirect(c.googleLoginRedirect); err != nil {
		return nil, err
	}
	proxies, err := parseProxies(os.Getenv("TRUSTED_PROXIES"))
	if err != nil {
		return nil, err
	}
	c.trustedProxies = proxies
	return c, nil
}

// newLogin builds Google sign-in, or returns nil when it isn't configured.
func (c *config) newLogin(ctx context.Context) auth.LoginProvider {
	if c.googleID == "" || c.googleLoginRedirect == "" {
		return nil
	}
	log.Print("auth: Google sign-in enabled")
	return auth.NewGoogleLogin(ctx, c.googleID, c.googleSecret, c.googleLoginRedirect)
}

// sessionSecret returns the key that signs session cookies. Release mode refuses to start
// without a strong one: a guessable key lets anyone forge a session for any user. Elsewhere
// a random key is fine, at the cost of signing everyone out on each restart.
func sessionSecret(raw, ginMode string) ([]byte, error) {
	switch {
	case raw != "" && len(raw) < minSecretBytes:
		return nil, fmt.Errorf("JWT_SECRET must be at least %d bytes (openssl rand -hex 32)", minSecretBytes)
	case raw != "":
		return []byte(raw), nil
	case ginMode == "release":
		return nil, errors.New("JWT_SECRET is required in release mode (openssl rand -hex 32)")
	}
	secret := make([]byte, minSecretBytes)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	log.Print("JWT_SECRET not set: using a random key, so everyone is logged out when the server restarts")
	return secret, nil
}

// checkRedirect insists on HTTPS outside local development: the redirect carries the
// authorization code, which must not cross the network in the clear.
func checkRedirect(raw string) error {
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("%q isn't a valid OAuth redirect URL", raw)
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return fmt.Errorf("the OAuth redirect URL %q must be https (or http on localhost)", raw)
	}
	return nil
}

// parseProxies reads TRUSTED_PROXIES: comma-separated addresses or CIDR ranges.
func parseProxies(raw string) ([]string, error) {
	var proxies []string
	for _, p := range strings.Split(raw, ",") {
		if p = strings.TrimSpace(p); p == "" {
			continue
		}
		if _, err := netip.ParseAddr(p); err != nil {
			if _, err := netip.ParsePrefix(p); err != nil {
				return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not an address or CIDR range", p)
			}
		}
		proxies = append(proxies, p)
	}
	return proxies, nil
}
