package api

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

const testClientID = "client-id.example"

// fakeIdP stands in for Google: real authorization code endpoints and real RSA-signed ID
// tokens, so these tests exercise the actual verification code rather than a mock of it.
type fakeIdP struct {
	t      *testing.T
	server *httptest.Server
	key    *rsa.PrivateKey

	// What the next sign-in returns. Tests change these to play a hostile provider.
	subject, email, name string
	verified             bool
	issuer, audience     string
	wrongKey             *rsa.PrivateKey
	expires              time.Duration
	nonceOverride        *string

	nonce, challenge string // captured from the authorization request
	verifierSeen     string // captured from the token request
	tokenStatus      int
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &fakeIdP{t: t, key: key, subject: "google-sub-1", email: "ada@gmail.example", name: "Ada", verified: true,
		audience: testClientID, expires: time.Hour}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /certs", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "k1",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
			"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		idp.verifierSeen = r.PostForm.Get("code_verifier")
		if idp.tokenStatus != 0 {
			w.WriteHeader(idp.tokenStatus)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "expires_in": 3600, "id_token": idp.idToken()})
	})
	idp.server = httptest.NewServer(mux)
	idp.issuer = idp.server.URL
	t.Cleanup(idp.server.Close)
	return idp
}

func (i *fakeIdP) idToken() string {
	i.t.Helper()
	nonce := i.nonce
	if i.nonceOverride != nil {
		nonce = *i.nonceOverride
	}
	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"iss": i.issuer, "aud": i.audience, "sub": i.subject, "email": i.email, "email_verified": i.verified,
		"name": i.name, "nonce": nonce, "iat": now.Unix(), "exp": now.Add(i.expires).Unix(),
	})
	token.Header["kid"] = "k1"
	key := i.key
	if i.wrongKey != nil {
		key = i.wrongKey
	}
	signed, err := token.SignedString(key)
	if err != nil {
		i.t.Fatal(err)
	}
	return signed
}

// googleEnv is a server with Google sign-in, plus browsers that don't follow redirects.
type googleEnv struct {
	*env
	idp    *fakeIdP
	server *httptest.Server
}

func setupGoogle(t *testing.T) *googleEnv {
	t.Helper()
	e := setup(t, "")
	idp := newFakeIdP(t)
	login := auth.NewOIDCLogin(t.Context(), auth.OIDCConfig{
		Name: "google", ClientID: testClientID, ClientSecret: "secret", RedirectURL: "http://app.example/api/auth/google/callback",
		AuthURL: idp.server.URL + "/auth", TokenURL: idp.server.URL + "/token", JWKSURL: idp.server.URL + "/certs", Issuer: idp.server.URL,
	})
	router := NewRouter(Deps{DB: e.db, Hub: e.hub, Engine: e.engine,
		Auth: auth.NewManager([]byte("test-secret"), false, e.db), Login: login}, "")
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return &googleEnv{env: e, idp: idp, server: server}
}

func (g *googleEnv) browser(t *testing.T) *client {
	t.Helper()
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: g.server.URL, http: &http.Client{Jar: jar,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

// visit follows nothing: it returns the status and the redirect target.
func visit(t *testing.T, c *client, path string) (int, string) {
	t.Helper()
	res, err := c.http.Get(c.base + path)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode, res.Header.Get("Location")
}

// startFlow goes to the provider and returns the state it was given.
func (g *googleEnv) startFlow(t *testing.T, c *client, path string) string {
	t.Helper()
	code, to := visit(t, c, path)
	if code != 302 {
		t.Fatalf("%s: %d", path, code)
	}
	link, err := url.Parse(to)
	if err != nil {
		t.Fatal(err)
	}
	q := link.Query()
	g.idp.nonce, g.idp.challenge = q.Get("nonce"), q.Get("code_challenge")
	if q.Get("code_challenge_method") != "S256" || g.idp.challenge == "" {
		t.Errorf("no S256 PKCE challenge in %s", to)
	}
	if g.idp.nonce == "" || q.Get("state") == "" {
		t.Errorf("no nonce or state in %s", to)
	}
	// Sign-in asks for who you are, and nothing more.
	if !strings.Contains(q.Get("scope"), "openid") || strings.Contains(q.Get("scope"), "calendar") {
		t.Errorf("scopes: %q", q.Get("scope"))
	}
	return q.Get("state")
}

// signIn runs a whole sign-in and returns where the callback sends the browser.
func (g *googleEnv) signIn(t *testing.T, c *client) string {
	t.Helper()
	state := g.startFlow(t, c, "/api/auth/google/start")
	code, to := visit(t, c, "/api/auth/google/callback?code=abc&state="+url.QueryEscape(state))
	if code != 302 {
		t.Fatalf("callback: %d", code)
	}
	return to
}

func TestGoogleSignInCreatesAnAccountAndKeepsNothingElse(t *testing.T) {
	g := setupGoogle(t)
	c := g.browser(t)
	if to := g.signIn(t, c); to != "/" {
		t.Fatalf("redirected to %q, want /", to)
	}
	// PKCE: what reached the token endpoint hashes to the challenge sent at the start.
	sum := sha256.Sum256([]byte(g.idp.verifierSeen))
	if base64.RawURLEncoding.EncodeToString(sum[:]) != g.idp.challenge {
		t.Errorf("verifier %q doesn't match challenge %q", g.idp.verifierSeen, g.idp.challenge)
	}
	var me struct {
		Email        string `json:"email"`
		Name         string `json:"name"`
		HasPassword  bool   `json:"has_password"`
		GoogleLinked bool   `json:"google_linked"`
	}
	if code := c.call("GET", "/api/me", nil, &me); code != 200 {
		t.Fatalf("me: %d", code)
	}
	if me.Email != "ada@gmail.example" || me.Name != "Ada" || me.HasPassword || !me.GoogleLinked {
		t.Errorf("me: %+v", me)
	}
	// An account with no password can't be signed in to with any password.
	if code := g.browser(t).call("POST", "/api/auth/login", obj{"email": "ada@gmail.example", "password": ""}, nil); code != 400 {
		t.Errorf("empty password: %d, want 400", code)
	}
	if code := g.browser(t).call("POST", "/api/auth/login", obj{"email": "ada@gmail.example", "password": "anything at all"}, nil); code != 401 {
		t.Errorf("any password: %d, want 401", code)
	}
	// Returning: the same account, not a second one.
	if to := g.signIn(t, g.browser(t)); to != "/" {
		t.Errorf("second sign-in went to %q", to)
	}
	var users int64
	g.db.Model(&store.User{}).Count(&users)
	if users != 1 {
		t.Errorf("%d accounts, want 1", users)
	}
}

func TestGoogleSignInMatchesOnSubjectNotEmail(t *testing.T) {
	g := setupGoogle(t)
	g.signIn(t, g.browser(t))
	// The address changed hands at Google: a new person, so not the old account.
	g.idp.subject = "google-sub-2"
	if to := g.signIn(t, g.browser(t)); to != "/login?error=account_exists" {
		t.Errorf("new person with a used address: %q", to)
	}
	// The same person with a new address keeps their account.
	g.idp.subject, g.idp.email = "google-sub-1", "ada.new@gmail.example"
	c := g.browser(t)
	if to := g.signIn(t, c); to != "/" {
		t.Errorf("new address: %q", to)
	}
	var me store.User
	c.call("GET", "/api/me", nil, &me)
	if me.Email != "ada@gmail.example" {
		t.Errorf("signed in as %q", me.Email)
	}
}

func TestGoogleSignInDoesNotJoinAPasswordAccountByEmail(t *testing.T) {
	g := setupGoogle(t)
	// An attacker registers the victim's address first, then waits for them to arrive.
	attacker := g.browser(t)
	if code := attacker.call("POST", "/api/auth/register", obj{"email": "ada@gmail.example", "password": testPassword}, nil); code != 201 {
		t.Fatalf("register: %d", code)
	}
	victim := g.browser(t)
	if to := g.signIn(t, victim); to != "/login?error=account_exists" {
		t.Fatalf("redirected to %q", to)
	}
	if code := victim.call("GET", "/api/me", nil, nil); code != 401 {
		t.Errorf("the victim was signed in to the attacker's account: %d", code)
	}
}

func TestGoogleSignInRefusesBadTokens(t *testing.T) {
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	wrongNonce := "someone-elses-nonce"
	for name, tc := range map[string]struct {
		change func(*fakeIdP)
		want   string
	}{
		"forged signature":  {func(i *fakeIdP) { i.wrongKey = otherKey }, "failed"},
		"another app's":     {func(i *fakeIdP) { i.audience = "another-client" }, "failed"},
		"another issuer":    {func(i *fakeIdP) { i.issuer = "https://evil.example" }, "failed"},
		"expired":           {func(i *fakeIdP) { i.expires = -time.Hour }, "failed"},
		"replayed nonce":    {func(i *fakeIdP) { i.nonceOverride = &wrongNonce }, "failed"},
		"unverified email":  {func(i *fakeIdP) { i.verified = false }, "unverified"},
		"bad code at token": {func(i *fakeIdP) { i.tokenStatus = 400 }, "failed"},
	} {
		t.Run(name, func(t *testing.T) {
			g := setupGoogle(t)
			tc.change(g.idp)
			c := g.browser(t)
			if to := g.signIn(t, c); to != "/login?error="+tc.want {
				t.Errorf("redirected to %q, want error=%s", to, tc.want)
			}
			if code := c.call("GET", "/api/me", nil, nil); code != 401 {
				t.Errorf("signed in anyway: %d", code)
			}
			var users int64
			g.db.Model(&store.User{}).Count(&users)
			if users != 0 {
				t.Errorf("%d accounts created", users)
			}
		})
	}
}

func TestGoogleCallbackRefusesLoginCSRF(t *testing.T) {
	g := setupGoogle(t)
	// The attacker starts a flow, and sends the victim the callback link with their code.
	state := g.startFlow(t, g.browser(t), "/api/auth/google/start")
	victim := g.browser(t)
	if _, to := visit(t, victim, "/api/auth/google/callback?code=attackers&state="+url.QueryEscape(state)); to != "/login?error=expired" {
		t.Errorf("redirected to %q", to)
	}
	if code := victim.call("GET", "/api/me", nil, nil); code != 401 {
		t.Errorf("the victim was signed in: %d", code)
	}
	// Having a sign-in of their own under way doesn't help: the state must match it.
	g.startFlow(t, victim, "/api/auth/google/start")
	if _, to := visit(t, victim, "/api/auth/google/callback?code=attackers&state="+url.QueryEscape(state)); to != "/login?error=expired" {
		t.Errorf("with a different flow in progress, redirected to %q", to)
	}
	if code := victim.call("GET", "/api/me", nil, nil); code != 401 {
		t.Errorf("the victim was signed in with the attacker's code: %d", code)
	}
	// A state can be used once.
	c := g.browser(t)
	state = g.startFlow(t, c, "/api/auth/google/start")
	callback := "/api/auth/google/callback?code=abc&state=" + url.QueryEscape(state)
	if _, to := visit(t, c, callback); to != "/" {
		t.Fatalf("first use: %q", to)
	}
	if _, to := visit(t, c, callback); to != "/login?error=expired" {
		t.Errorf("second use: %q", to)
	}
}

func TestGoogleDeniedOnTheConsentScreen(t *testing.T) {
	g := setupGoogle(t)
	c := g.browser(t)
	state := g.startFlow(t, c, "/api/auth/google/start")
	if _, to := visit(t, c, "/api/auth/google/callback?error=access_denied&state="+url.QueryEscape(state)); to != "/login?error=denied" {
		t.Errorf("redirected to %q", to)
	}
}

func TestLinkingGoogleToAPasswordAccount(t *testing.T) {
	g := setupGoogle(t)
	c := g.browser(t)
	if code := c.call("POST", "/api/auth/register", obj{"email": "ada@example.com", "password": testPassword}, nil); code != 201 {
		t.Fatalf("register: %d", code)
	}
	state := g.startFlow(t, c, "/api/auth/google/link")
	if _, to := visit(t, c, "/api/auth/google/callback?code=abc&state="+url.QueryEscape(state)); to != "/settings?google=linked" {
		t.Fatalf("link: %q", to)
	}
	// Now Google signs in to that same account, under whichever email Google holds.
	fresh := g.browser(t)
	if to := g.signIn(t, fresh); to != "/" {
		t.Fatalf("sign-in after linking: %q", to)
	}
	var me store.User
	fresh.call("GET", "/api/me", nil, &me)
	if me.Email != "ada@example.com" {
		t.Errorf("signed in as %q", me.Email)
	}
	// Someone else can't claim the same Google account.
	bob := g.browser(t)
	bob.call("POST", "/api/auth/register", obj{"email": "bob@example.com", "password": testPassword}, nil)
	state = g.startFlow(t, bob, "/api/auth/google/link")
	if _, to := visit(t, bob, "/api/auth/google/callback?code=abc&state="+url.QueryEscape(state)); to != "/settings?google=in_use" {
		t.Errorf("second account: %q", to)
	}
	// Linking needs the session that started it to still be signed in.
	state = g.startFlow(t, bob, "/api/auth/google/link")
	bob.call("POST", "/api/auth/logout", nil, nil)
	if _, to := visit(t, bob, "/api/auth/google/callback?code=abc&state="+url.QueryEscape(state)); to != "/settings?google=expired" {
		t.Errorf("signed out mid-flow: %q", to)
	}
	// Unlinking.
	if code := c.call("DELETE", "/api/auth/google", nil, nil); code != 204 {
		t.Fatalf("unlink: %d", code)
	}
}

func TestLinkingNeedsASession(t *testing.T) {
	g := setupGoogle(t)
	if code, _ := visit(t, g.browser(t), "/api/auth/google/link"); code != 401 {
		t.Errorf("link when signed out: %d, want 401", code)
	}
}

func TestAGoogleOnlyAccountCantRemoveItsOnlySignIn(t *testing.T) {
	g := setupGoogle(t)
	c := g.browser(t)
	g.signIn(t, c)
	if code := c.call("DELETE", "/api/auth/google", nil, nil); code != 409 {
		t.Errorf("unlink with no password: %d, want 409", code)
	}
	// Setting a first password needs no current one, and then unlinking works.
	if code := c.call("PUT", "/api/me/password", obj{"new": "plum lantern gravity orbit"}, nil); code != 204 {
		t.Fatalf("first password: %d", code)
	}
	if code := c.call("DELETE", "/api/auth/google", nil, nil); code != 204 {
		t.Errorf("unlink with a password: %d, want 204", code)
	}
}

func TestProvidersTellsTheLoginPageWhatToShow(t *testing.T) {
	g := setupGoogle(t)
	var withGoogle, without struct {
		Google bool `json:"google"`
	}
	g.browser(t).call("GET", "/api/auth/providers", nil, &withGoogle)
	if !withGoogle.Google {
		t.Error("google should be on")
	}
	e := setup(t, "")
	e.anonymous(t).call("GET", "/api/auth/providers", nil, &without)
	if without.Google {
		t.Error("google should be off")
	}
	if code, _ := visit(t, &client{t: t, http: http.DefaultClient, base: e.server.URL}, "/api/auth/google/start"); code != 404 {
		t.Errorf("start with no provider: %d, want 404", code)
	}
}
