package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"

	"github.com/gin-gonic/gin"
)

// Angular's HttpClient reads this cookie and echoes it in this header on every
// state-changing request to the same origin, so the frontend needs no code for it.
const (
	CSRFCookie = "XSRF-TOKEN"
	CSRFHeader = "X-XSRF-TOKEN"
	csrfMaxAge = 365 * 24 * 60 * 60
)

// CSRF is double-submit protection. Every response carries a random token in a cookie
// page scripts can read; every POST, PUT, PATCH and DELETE must send the same token in a
// header. Another site can make the browser send the cookie, but it can't read it to
// copy into the header. SameSite=Lax on the session cookie already stops most cross-site
// requests; this closes the rest, including login CSRF.
func (m *Manager) CSRF() gin.HandlerFunc {
	return func(c *gin.Context) {
		token, err := c.Cookie(CSRFCookie)
		if err != nil || len(token) != 64 {
			b := make([]byte, 32)
			_, _ = rand.Read(b)
			token = hex.EncodeToString(b)
			c.SetSameSite(http.SameSiteLaxMode)
			c.SetCookie(CSRFCookie, token, csrfMaxAge, "/", "", m.secure, false) // readable by the page, by design
		}
		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			c.Next()
			return
		}
		if sent := c.GetHeader(CSRFHeader); sent == "" || subtle.ConstantTimeCompare([]byte(sent), []byte(token)) != 1 {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "this request is missing its security token; reload the page and try again"})
			return
		}
		c.Next()
	}
}
