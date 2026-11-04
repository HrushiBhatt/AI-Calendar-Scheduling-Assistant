// Package api is the Brew Focus HTTP layer: a Gin router over the store, auth, the
// timer engine and the event hub.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/go-playground/validator/v10"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/assistant"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/calendar"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/scheduler"
)

// Deps are the long-lived services the HTTP layer uses.
type Deps struct {
	DB         *gorm.DB
	Auth       *auth.Manager
	Hub        *events.Hub
	Engine     *engine.Engine
	Calendar   *calendar.Service
	Plans      *plans.Service
	Dispatcher *scheduler.Dispatcher
	Assistant  *assistant.Assistant // nil without an Anthropic key: the form path takes over
	Login      auth.LoginProvider   // nil without Google sign-in configured: passwords only
	// TrustedProxies are the addresses allowed to report a client's real IP, for rate
	// limiting. Empty means the connection's address is the client's.
	TrustedProxies []string
	// Keepalive is how often an event stream pings and re-checks its session. Zero means 25 s.
	Keepalive time.Duration
}

type handler struct {
	Deps
	syncLimit *limiter // POST /api/calendar/sync: once a minute per user
	planLimit *limiter // POST /api/assistant/plan, per user
	planIP    *limiter // and per address
	// Sign-in and sign-up: per address, and per account being guessed at.
	authIP       *limiter
	loginAccount *limiter
	passwordUser *limiter // PUT /api/me/password: guessing the current password from a stolen session
	apiIP        *limiter // everything under /api, per address: a blunt limit against scraping and floods
}

// NewRouter wires every /api route. When staticDir is set it also serves the built
// Angular app from that directory, falling back to index.html for client-side routes.
func NewRouter(d Deps, staticDir string) *gin.Engine {
	r := gin.New()
	r.Use(baseMiddleware(d.Auth.Secure())...)
	if err := r.SetTrustedProxies(d.TrustedProxies); err != nil {
		log.Printf("api: ignoring TRUSTED_PROXIES: %v", err)
	}

	h := &handler{Deps: d, syncLimit: newLimiter(1, time.Minute), planLimit: newLimiter(20, time.Minute), planIP: newLimiter(60, time.Minute),
		authIP: newLimiter(20, time.Minute), loginAccount: newLimiter(10, 10*time.Minute),
		passwordUser: newLimiter(5, 10*time.Minute), apiIP: newLimiter(600, time.Minute)}
	if h.Keepalive == 0 {
		h.Keepalive = keepalive
	}

	// Google's push webhook has no session and no CSRF token: it is verified by channel ID
	// and token instead. It is registered outside the /api group's middleware, so neither
	// CSRF nor any future global rate limit can throttle Google's notifications.
	r.POST("/api/calendar/push", h.calendarPush)

	api := r.Group("/api", noStore(), crossOriginProtection(), perIP(h.apiIP, "api"), d.Auth.CSRF())
	api.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	api.POST("/auth/register", perIP(h.authIP, "auth"), h.register)
	api.POST("/auth/login", perIP(h.authIP, "auth"), h.login)
	api.POST("/auth/logout", h.logout)
	api.GET("/auth/providers", h.authProviders)
	api.GET("/auth/google/start", perIP(h.authIP, "auth"), h.googleStart)
	api.GET("/auth/google/callback", perIP(h.authIP, "auth"), h.googleCallback)

	my := api.Group("", d.Auth.Required())
	my.GET("/me", h.me)
	my.PUT("/me/settings", h.saveSettings)
	my.PUT("/me/password", perUser(h.passwordUser, "password"), h.changePassword)
	my.POST("/auth/logout-all", h.logoutAll)
	my.GET("/auth/google/link", perIP(h.authIP, "auth"), h.googleLink)
	my.DELETE("/auth/google", h.googleUnlink)

	my.GET("/presets", h.listPresets)
	my.POST("/presets", h.createPreset)
	my.DELETE("/presets/:id", h.deletePreset)

	my.GET("/tasks", h.listTasks)
	my.POST("/tasks", h.createTask)
	my.PATCH("/tasks/:id", h.updateTask)
	my.DELETE("/tasks/:id", h.deleteTask)

	my.GET("/timer", h.timer)
	my.POST("/timer/:action", h.controlTimer)
	my.GET("/events", h.events)

	my.GET("/sessions", h.listSessions)
	my.PATCH("/sessions/:id", h.reflect)
	my.DELETE("/sessions", h.clearSessions)
	my.GET("/stats", h.stats)
	my.GET("/insights", h.insights)

	my.GET("/calendar/connect", h.calendarConnect)
	my.GET("/calendar/callback", h.calendarCallback)
	my.GET("/calendar/accounts", h.calendarAccounts)
	my.DELETE("/calendar/accounts/:id", h.calendarDisconnect)
	my.POST("/calendar/sync", perUser(h.syncLimit, "sync"), h.calendarSync)
	my.GET("/schedule", h.schedule)

	my.POST("/assistant/plan", perIP(h.planIP, "plan"), perUser(h.planLimit, "plan"), h.requestPlan)
	my.GET("/plans/live", h.livePlans)
	my.GET("/plans/:id", h.getPlan)
	my.POST("/plans/:id/accept", h.acceptPlan)
	my.POST("/plans/:id/reject", h.rejectPlan)
	my.PATCH("/scheduled/:id", h.moveBlock)
	my.DELETE("/scheduled/:id", h.dropBlock)
	my.POST("/scheduled/:id/start", h.startBlock)

	r.NoRoute(func(c *gin.Context) {
		isRead := c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead
		if staticDir == "" || !isRead || strings.HasPrefix(c.Request.URL.Path, "/api/") {
			notFound(c)
			return
		}
		file := filepath.Join(staticDir, filepath.Clean("/"+c.Request.URL.Path)) // Clean blocks ../ escapes
		if info, err := os.Stat(file); err == nil && !info.IsDir() {
			c.File(file)
			return
		}
		c.File(filepath.Join(staticDir, "index.html"))
	})
	return r
}

// changed tells the user's other tabs and devices to refetch a resource.
func (h *handler) changed(userID uint, kind string) {
	h.Hub.Publish(userID, events.Event{Type: "changed", Data: gin.H{"kind": kind}})
}

// ---- request validation ------------------------------------------------------------

func init() {
	// Report validation errors by JSON field name ("focus"), not Go field name ("Focus").
	if v, ok := binding.Validator.Engine().(*validator.Validate); ok {
		v.RegisterTagNameFunc(func(f reflect.StructField) string {
			return strings.SplitN(f.Tag.Get("json"), ",", 2)[0]
		})
	}
}

// bind decodes and validates the JSON body, replying 400 with a readable message on failure.
func bind(c *gin.Context, dst any) bool {
	if err := c.ShouldBindJSON(dst); err != nil {
		badRequest(c, describe(err))
		return false
	}
	return true
}

func describe(err error) string {
	var fields validator.ValidationErrors
	if errors.As(err, &fields) {
		f := fields[0]
		switch f.Tag() {
		case "required":
			return f.Field() + " is required"
		case "email":
			return "that doesn't look like an email address"
		case "oneof":
			return fmt.Sprintf("%s must be one of: %s", f.Field(), f.Param())
		case "datetime":
			return f.Field() + " must be a YYYY-MM-DD date"
		case "min", "max":
			bound := map[string]string{"min": "at least", "max": "at most"}[f.Tag()]
			if f.Kind() == reflect.String {
				return fmt.Sprintf("%s must be %s %s characters", f.Field(), bound, f.Param())
			}
			return fmt.Sprintf("%s must be %s %s", f.Field(), bound, f.Param())
		}
		return f.Field() + " is invalid"
	}
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) {
		return typeErr.Field + " has the wrong type"
	}
	return "expected a JSON object"
}

// ---- responses -----------------------------------------------------------------------

func idParam(c *gin.Context) (uint, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		notFound(c)
		return 0, false
	}
	return uint(id), true
}

// ok reports whether err is nil; otherwise it replies 500 and records the error for the logger.
func ok(c *gin.Context, err error) bool {
	if err != nil {
		_ = c.Error(err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "something went wrong on our side"})
		return false
	}
	return true
}

// found replies 404 for a missing record and 500 for any other error.
func found(c *gin.Context, err error) bool {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		notFound(c)
		return false
	}
	return ok(c, err)
}

func badRequest(c *gin.Context, msg string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": msg})
}

func notFound(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
}
