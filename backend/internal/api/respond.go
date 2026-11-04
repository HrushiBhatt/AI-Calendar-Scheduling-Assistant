package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
	"github.com/go-playground/validator/v10"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
)

// This file holds the helpers every handler shares: reading a request and writing a reply.

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

// describe turns a binding error into a sentence the UI can show as it is.
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

// idParam reads the :id path parameter. A malformed ID is simply a record that doesn't exist.
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

// badRequest replies 400 with a message the UI can show.
func badRequest(c *gin.Context, msg string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": msg})
}

// notFound replies 404. Another user's record gets this too, so IDs reveal nothing.
func notFound(c *gin.Context) {
	c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
}

// deleteOwned deletes the :id record of model if it belongs to the signed-in user.
func (h *handler) deleteOwned(c *gin.Context, model any, kind string) {
	uid := auth.UserID(c)
	id, valid := idParam(c)
	if !valid {
		return
	}
	res := h.DB.Where("id = ? AND user_id = ?", id, uid).Delete(model)
	if !ok(c, res.Error) {
		return
	}
	if res.RowsAffected == 0 {
		notFound(c)
		return
	}
	h.changed(uid, kind)
	c.Status(http.StatusNoContent)
}
