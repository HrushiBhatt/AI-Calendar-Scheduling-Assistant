package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"net/netip"
	"strings"
)

// Settings come from environment variables, the usual way to configure a container: the same
// image runs anywhere, and secrets stay out of the code. Anything invalid stops the server at
// startup, so a mistake can't surface later as a confusing failure.

// minSecretBytes matches the HS256 key size: 32 random bytes, or 64 hex characters.
const minSecretBytes = 32

// sessionSecret returns the key that signs JWTs. Release mode refuses to start without a
// strong one: a guessable key lets anyone forge a session for any user. Elsewhere a random key
// is fine, at the cost of signing everyone out on each restart.
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

// parseProxies reads TRUSTED_PROXIES: comma-separated addresses or CIDR ranges. Rate limits
// need each visitor's real address, and only a listed proxy may report it.
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
