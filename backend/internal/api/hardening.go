package api

import (
	"bytes"
	"errors"
	"io"
	"log"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	// maxBody bounds a request body. The largest legitimate one is a plan request of a few
	// kilobytes, so this stops memory exhaustion without ever being reached in normal use.
	maxBody = 256 << 10
	// bodyWait bounds how long a client may take to send it, so a client trickling bytes
	// can't hold a connection open. Event streams and slow model calls aren't affected:
	// the deadline is lifted as soon as the body has arrived.
	bodyWait = 15 * time.Second
)

// contentPolicy lets the page load only its own code, styles, fonts and images, so
// injected markup can't run a script or send a user's data anywhere. Inline styles stay
// allowed because Angular writes component styles into the page; scripts have no such
// exception. Ambience tracks a user picks from their own disk play from blob: URLs.
const contentPolicy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
	"font-src 'self'; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; base-uri 'self'; " +
	"form-action 'self'; frame-ancestors 'none'"

// baseMiddleware runs on every request. Query strings stay out of the log because OAuth
// callbacks carry the authorization code there.
func baseMiddleware(secure bool) []gin.HandlerFunc {
	return []gin.HandlerFunc{
		gin.LoggerWithConfig(gin.LoggerConfig{SkipQueryString: true}),
		recoverPanics(),
		securityHeaders(secure),
		readBody(maxBody, bodyWait),
	}
}

// securityHeaders sets the browser protections on every response, API and frontend alike.
func securityHeaders(secure bool) gin.HandlerFunc {
	policy := contentPolicy
	if secure {
		policy += "; upgrade-insecure-requests"
	}
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("Content-Security-Policy", policy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if secure {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		c.Next()
	}
}

// noStore keeps a user's data out of browser and proxy caches.
func noStore() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Next()
	}
}

// crossOriginProtection rejects state-changing requests a browser marks as coming from
// another site. It sits in front of the CSRF token as a second, independent check.
func crossOriginProtection() gin.HandlerFunc {
	protection := http.NewCrossOriginProtection()
	return func(c *gin.Context) {
		if err := protection.Check(c.Request); err != nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "that request came from another site"})
			return
		}
		c.Next()
	}
}

// readBody reads the whole request body up front, within a size and time limit.
func readBody(limit int64, wait time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body == nil || c.Request.Body == http.NoBody {
			c.Next()
			return
		}
		rc := http.NewResponseController(c.Writer)
		_ = rc.SetReadDeadline(time.Now().Add(wait))
		body, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, limit))
		_ = rc.SetReadDeadline(time.Time{})
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{"error": "that request is too large"})
			return
		case err != nil:
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "the request body couldn't be read"})
			return
		}
		c.Request.Body = io.NopCloser(bytes.NewReader(body))
		c.Next()
	}
}

// recoverPanics answers a panic with the usual 500. It replaces gin.Recovery, whose log
// includes the request's headers: masking Authorization but printing the session cookie.
func recoverPanics() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler { //nolint:errorlint // the sentinel net/http re-panics with
				panic(v)
			}
			log.Printf("panic on %s %s: %v\n%s", c.Request.Method, c.Request.URL.Path, v, debug.Stack())
			if c.Writer.Written() {
				c.Abort()
				return
			}
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "something went wrong on our side"})
		}()
		c.Next()
	}
}
