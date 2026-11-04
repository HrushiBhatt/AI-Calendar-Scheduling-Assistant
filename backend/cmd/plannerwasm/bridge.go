// Command plannerwasm is the scheduler compiled to WebAssembly, for the GitHub Pages demo.
// Pages can't run the Go server, so the demo's in-browser backend calls this instead of
// reimplementing the scheduler: the same code, with the same golden tests behind it.
//
//	GOOS=js GOARCH=wasm go build -o planner.wasm ./cmd/plannerwasm
package main

import (
	"encoding/json"
	"time"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/planner"
)

type failure struct {
	Error string `json:"error"`
}

// planJSON runs the planner on a JSON planner.Input and returns a JSON planner.Result.
func planJSON(input string) string {
	var in planner.Input
	if err := json.Unmarshal([]byte(input), &in); err != nil {
		return encode(failure{err.Error()})
	}
	res, err := planner.Plan(in)
	if err != nil {
		return encode(failure{err.Error()})
	}
	return encode(res)
}

type checkRequest struct {
	Input planner.Input `json:"input"`
	Start time.Time     `json:"start"`
	Mode  planner.Mode  `json:"mode"`
}

type checkResult struct {
	Code string     `json:"code"` // "" means the slot is fine
	At   *time.Time `json:"at,omitempty"`
	End  *time.Time `json:"end,omitempty"`
}

// checkJSON validates one block placed by hand, using the planner's own rules.
func checkJSON(request string) string {
	var req checkRequest
	if err := json.Unmarshal([]byte(request), &req); err != nil {
		return encode(failure{err.Error()})
	}
	v, err := planner.Check(req.Input, req.Start, req.Mode)
	if err != nil {
		return encode(failure{err.Error()})
	}
	out := checkResult{Code: v.Code}
	if !v.At.IsZero() {
		out.At, out.End = &v.At, &v.End
	}
	return encode(out)
}

func encode(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `{"error":"couldn't encode the result"}`
	}
	return string(b)
}
