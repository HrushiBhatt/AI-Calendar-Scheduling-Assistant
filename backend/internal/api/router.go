// Package api is the Brew Focus HTTP layer: a Gin router over the store, auth, the timer
// engine and the event hub. Handlers are grouped by resource, one file each.
package api

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/api/middleware"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
)

// Deps are the long-lived services the HTTP layer uses.
type Deps struct {
	DB     *gorm.DB
	Auth   *auth.Manager
	Hub    *events.Hub
	Engine *engine.Engine
	Login  auth.LoginProvider // nil without Google sign-in configured: passwords only
	// TrustedProxies are the addresses allowed to report a client's real IP, for rate
	// limiting. Empty means the connection's address is the client's.
	TrustedProxies []string
	// Keepalive is how often an event stream pings and re-checks its session. Zero means 25 s.
	Keepalive time.Duration
}

// handler carries the dependencies and rate limits shared by every route.
type handler struct {
	Deps
	authIP       *middleware.Limiter // sign-in and sign-up, per address
	loginAccount *middleware.Limiter // sign-in, per account being guessed at
	passwordUser *middleware.Limiter // PUT /api/me/password: guessing the current password from a stolen session
	apiIP        *middleware.Limiter // everything under /api, per address: a blunt limit against floods
}

// NewRouter wires every /api route. When staticDir is set it also serves the built Angular
// app from that directory, falling back to index.html for client-side routes.
func NewRouter(d Deps, staticDir string) *gin.Engine {
	r := gin.New()
	r.Use(middleware.Base(d.Auth.Secure())...)
	if err := r.SetTrustedProxies(d.TrustedProxies); err != nil {
		log.Printf("api: ignoring TRUSTED_PROXIES: %v", err)
	}

	h := &handler{
		Deps:         d,
		authIP:       middleware.NewLimiter(20, time.Minute),
		loginAccount: middleware.NewLimiter(10, 10*time.Minute),
		passwordUser: middleware.NewLimiter(5, 10*time.Minute),
		apiIP:        middleware.NewLimiter(600, time.Minute),
	}
	if h.Keepalive == 0 {
		h.Keepalive = keepalive
	}

	// Routes anyone can reach.
	api := r.Group("/api", middleware.NoStore(), middleware.CrossOriginProtection(), middleware.PerIP(h.apiIP, "api"), d.Auth.CSRF())
	api.GET("/health", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	api.POST("/auth/register", middleware.PerIP(h.authIP, "auth"), h.register)
	api.POST("/auth/login", middleware.PerIP(h.authIP, "auth"), h.login)
	api.POST("/auth/logout", h.logout)
	api.GET("/auth/providers", h.authProviders)
	api.GET("/auth/google/start", middleware.PerIP(h.authIP, "auth"), h.googleStart)
	api.GET("/auth/google/callback", middleware.PerIP(h.authIP, "auth"), h.googleCallback)

	// Routes that need a signed-in user. Every query below is scoped to that user.
	my := api.Group("", d.Auth.Required())
	my.GET("/me", h.me)
	my.PUT("/me/settings", h.saveSettings)
	my.PUT("/me/password", middleware.PerUser(h.passwordUser, "password"), h.changePassword)
	my.POST("/auth/logout-all", h.logoutAll)
	my.GET("/auth/google/link", middleware.PerIP(h.authIP, "auth"), h.googleLink)
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

	// Anything else: a file of the built app, or index.html so the Angular router can take it.
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
