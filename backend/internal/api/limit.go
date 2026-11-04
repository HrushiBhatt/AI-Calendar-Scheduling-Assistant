package api

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
)

// limiter allows n requests per window for each key, in fixed windows held in memory.
// That is right for one process; several replicas would need a shared store.
type limiter struct {
	n      int
	window time.Duration
	now    func() time.Time

	mu   sync.Mutex
	hits map[string]*bucket
}

type bucket struct {
	start time.Time
	count int
}

func newLimiter(n int, window time.Duration) *limiter {
	return &limiter{n: n, window: window, now: time.Now, hits: map[string]*bucket{}}
}

// allow records a request for key and reports whether it is within the limit, and if not,
// how long until the window resets.
func (l *limiter) allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.hits) > 10_000 { // sweep expired windows so the map can't grow without bound
		for k, b := range l.hits {
			if now.Sub(b.start) >= l.window {
				delete(l.hits, k)
			}
		}
	}
	b := l.hits[key]
	if b == nil || now.Sub(b.start) >= l.window {
		l.hits[key] = &bucket{start: now, count: 1}
		return true, 0
	}
	if b.count >= l.n {
		return false, b.start.Add(l.window).Sub(now)
	}
	b.count++
	return true, 0
}

// perIP limits by client address.
func perIP(l *limiter, scope string) gin.HandlerFunc {
	return limitBy(l, func(c *gin.Context) string { return scope + ":ip:" + c.ClientIP() })
}

// perUser limits by signed-in user. Only valid behind auth.Required.
func perUser(l *limiter, scope string) gin.HandlerFunc {
	return limitBy(l, func(c *gin.Context) string { return scope + ":user:" + strconv.FormatUint(uint64(auth.UserID(c)), 10) })
}

func limitBy(l *limiter, key func(*gin.Context) string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if ok, wait := l.allow(key(c)); !ok {
			secs := int(math.Ceil(wait.Seconds()))
			c.Header("Retry-After", strconv.Itoa(secs))
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": fmt.Sprintf("too many requests: try again in %d seconds", secs)})
			return
		}
		c.Next()
	}
}
