// Package store defines the database models and opens the SQLite database.
package store

import (
	"log"
	"os"
	"strings"
	"time"

	"github.com/glebarez/sqlite" // pure-Go SQLite driver: no C compiler needed
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Open connects to the SQLite database at path (":memory:" for tests) and migrates the schema.
func Open(path string) (*gorm.DB, error) {
	dsn := path
	if path != ":memory:" {
		if err := restrictFile(path); err != nil {
			return nil, err
		}
		// WAL lets readers proceed while a write is in flight, and the busy timeout makes a
		// writer wait for the lock instead of failing: HTTP handlers and the timer engine
		// share this database.
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		dsn = path + sep + "_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	}
	db, err := gorm.Open(&sqlite.Dialector{DriverName: utcDriverName, DSN: dsn}, &gorm.Config{
		NowFunc: func() time.Time { return time.Now().UTC() },
		Logger: logger.New(log.New(os.Stderr, "", log.LstdFlags), logger.Config{
			SlowThreshold:             200 * time.Millisecond,
			LogLevel:                  logger.Warn,
			IgnoreRecordNotFoundError: true, // a 404, not a problem worth logging
			// Log the SQL, never its values: they can be emails or password hashes.
			ParameterizedQueries: true,
		}),
	})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	// One connection: SQLite serializes writes anyway, and ":memory:" gives each connection its own database.
	sqlDB.SetMaxOpenConns(1)
	return db, db.AutoMigrate(&User{}, &LoginSession{}, &Identity{}, &Preset{}, &Task{}, &Session{})
}

// restrictFile makes the database readable by this user alone: it holds password hashes.
// SQLite gives its -wal and -shm files the same permissions.
func restrictFile(path string) error {
	name, _, _ := strings.Cut(path, "?")
	if name == "" || strings.HasPrefix(name, "file:") {
		return nil // a URI's options are the caller's business
	}
	f, err := os.OpenFile(name, os.O_CREATE|os.O_RDWR, 0o600) // #nosec G304 -- the operator's DB_PATH
	if err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Chmod(name, 0o600)
}
