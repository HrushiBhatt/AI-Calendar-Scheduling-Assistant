package store

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"time"

	_ "github.com/glebarez/go-sqlite" // registers "sqlite", which the wrapper below delegates to
)

// utcDriverName is the SQLite driver the store uses: the pure-Go one, with every time
// argument converted to UTC first.
//
// The driver writes a time.Time as text with whatever offset the value carries, and
// SQLite compares those strings, not instants. Rows are written in UTC, so a query bound
// with a time in another zone ("starts_at <= ?" with time.Now() on a server in New York,
// or a day boundary in the user's zone) compares wrong, silently, near midnight. Doing the
// conversion here, once, means no query can forget it.
const utcDriverName = "sqlite-utc"

func init() {
	db, err := sql.Open("sqlite", ":memory:") // sql.Open doesn't connect; it just finds the driver
	if err != nil {
		panic(err)
	}
	sql.Register(utcDriverName, utcDriver{inner: db.Driver()})
	_ = db.Close()
}

type utcDriver struct{ inner driver.Driver }

func (d utcDriver) Open(name string) (driver.Conn, error) {
	c, err := d.inner.Open(name)
	if err != nil {
		return nil, err
	}
	return &utcConn{Conn: c}, nil
}

// utcConn passes everything through to the real connection, including the optional
// context-aware interfaces, which embedding the driver.Conn interface would hide.
type utcConn struct{ driver.Conn }

// CheckNamedValue converts each argument as database/sql would by default, then moves
// times to UTC.
func (c *utcConn) CheckNamedValue(nv *driver.NamedValue) error {
	v, err := driver.DefaultParameterConverter.ConvertValue(nv.Value)
	if err != nil {
		return err
	}
	if t, ok := v.(time.Time); ok {
		v = t.UTC()
	}
	nv.Value = v
	return nil
}

func (c *utcConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	if b, ok := c.Conn.(driver.ConnBeginTx); ok {
		return b.BeginTx(ctx, opts)
	}
	return c.Conn.Begin() //nolint:staticcheck // the fallback database/sql itself uses
}

func (c *utcConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if p, ok := c.Conn.(driver.ConnPrepareContext); ok {
		return p.PrepareContext(ctx, query)
	}
	return c.Conn.Prepare(query)
}

func (c *utcConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if e, ok := c.Conn.(driver.ExecerContext); ok {
		return e.ExecContext(ctx, query, args)
	}
	return nil, driver.ErrSkip
}

func (c *utcConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if q, ok := c.Conn.(driver.QueryerContext); ok {
		return q.QueryContext(ctx, query, args)
	}
	return nil, driver.ErrSkip
}

func (c *utcConn) Ping(ctx context.Context) error {
	if p, ok := c.Conn.(driver.Pinger); ok {
		return p.Ping(ctx)
	}
	return nil
}
