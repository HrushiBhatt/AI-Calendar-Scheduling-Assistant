package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// ErrEmailUnverified means the provider won't vouch for the account's email address.
var ErrEmailUnverified = errors.New("the provider has not verified this account's email")

// Identity is who a provider says signed in. Subject never changes for an account; an
// email address can, and can later belong to someone else, so accounts link on Subject.
type Identity struct {
	Provider, Subject, Email, Name string
}

// LoginProvider is an OAuth 2.0 sign-in provider, using the authorization code flow.
type LoginProvider interface {
	Name() string
	AuthURL(state, nonce, verifier string) string
	Exchange(ctx context.Context, code, nonce, verifier string) (Identity, error)
}

// OIDCConfig describes an OpenID Connect provider's client and endpoints.
type OIDCConfig struct {
	Name, ClientID, ClientSecret, RedirectURL string
	AuthURL, TokenURL, JWKSURL, Issuer        string
}

// OIDCLogin signs people in with OpenID Connect, the identity layer on OAuth 2.0. It asks
// only for name and email, and keeps nothing from the provider but the verified identity:
// its access token is discarded, so a sign-in grants this app no access to the account.
type OIDCLogin struct {
	name     string
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

// NewOIDCLogin builds a provider. ctx bounds its background fetches of signing keys.
func NewOIDCLogin(ctx context.Context, cfg OIDCConfig) *OIDCLogin {
	return &OIDCLogin{
		name: cfg.Name,
		oauth: &oauth2.Config{
			ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, RedirectURL: cfg.RedirectURL,
			Endpoint: oauth2.Endpoint{AuthURL: cfg.AuthURL, TokenURL: cfg.TokenURL, AuthStyle: oauth2.AuthStyleInParams},
			Scopes:   []string{oidc.ScopeOpenID, "email", "profile"},
		},
		verifier: oidc.NewVerifier(cfg.Issuer, oidc.NewRemoteKeySet(ctx, cfg.JWKSURL), &oidc.Config{ClientID: cfg.ClientID}),
	}
}

// NewGoogleLogin signs people in with Google, using the OAuth client from the Cloud console.
func NewGoogleLogin(ctx context.Context, clientID, clientSecret, redirectURL string) *OIDCLogin {
	return NewOIDCLogin(ctx, OIDCConfig{
		Name: "google", ClientID: clientID, ClientSecret: clientSecret, RedirectURL: redirectURL,
		AuthURL: google.Endpoint.AuthURL, TokenURL: google.Endpoint.TokenURL,
		JWKSURL: "https://www.googleapis.com/oauth2/v3/certs", Issuer: "https://accounts.google.com",
	})
}

func (l *OIDCLogin) Name() string { return l.name }

// AuthURL sends PKCE's challenge and the nonce with the request. The verifier stays here
// until the code exchange, so a stolen authorization code is useless on its own.
func (l *OIDCLogin) AuthURL(state, nonce, verifier string) string {
	return l.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("prompt", "select_account"))
}

// Exchange trades the code for an ID token and verifies it: the provider's signature,
// issuer, audience (this app), expiry and the nonce from this very flow. Errors carry the
// status at most, never a token or the code.
func (l *OIDCLogin) Exchange(ctx context.Context, code, nonce, verifier string) (Identity, error) {
	tok, err := l.oauth.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		var denied *oauth2.RetrieveError
		if errors.As(err, &denied) {
			return Identity{}, fmt.Errorf("%s: the token endpoint answered %d", l.name, denied.Response.StatusCode)
		}
		return Identity{}, fmt.Errorf("%s: couldn't reach the token endpoint", l.name)
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok || raw == "" {
		return Identity{}, fmt.Errorf("%s: the response had no ID token", l.name)
	}
	id, err := l.verifier.Verify(ctx, raw)
	if err != nil {
		return Identity{}, fmt.Errorf("%s: the ID token failed verification", l.name)
	}
	if subtle.ConstantTimeCompare([]byte(id.Nonce), []byte(nonce)) != 1 {
		return Identity{}, fmt.Errorf("%s: the ID token's nonce doesn't match this sign-in", l.name)
	}
	var claims struct {
		Email    string `json:"email"`
		Verified bool   `json:"email_verified"`
		Name     string `json:"name"`
	}
	if err := id.Claims(&claims); err != nil {
		return Identity{}, fmt.Errorf("%s: unreadable claims in the ID token", l.name)
	}
	if !claims.Verified || claims.Email == "" {
		return Identity{}, ErrEmailUnverified
	}
	return Identity{Provider: l.name, Subject: id.Subject, Email: claims.Email, Name: claims.Name}, nil
}
