package demo

import (
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

func TestSeedCreatesTheAccountOnce(t *testing.T) {
	auth.Cost = bcrypt.MinCost
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	for range 2 { // the second run must change nothing
		if err := Seed(db, now); err != nil {
			t.Fatal(err)
		}
	}
	var users, tasks, sessions int64
	db.Model(&store.User{}).Where("email = ?", Email).Count(&users)
	db.Model(&store.Task{}).Count(&tasks)
	db.Model(&store.Session{}).Where("state = ?", store.StateDone).Count(&sessions)
	if users != 1 || tasks != 4 {
		t.Errorf("users = %d, tasks = %d", users, tasks)
	}
	if sessions < 20 {
		t.Errorf("only %d past sessions: the progress page would look empty", sessions)
	}
}
