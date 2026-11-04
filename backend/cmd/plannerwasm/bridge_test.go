package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The demo reaches the planner through JSON, so every golden fixture must come out the
// same through this door as it does when the planner is called directly.
func TestBridgeReproducesEveryGoldenFixture(t *testing.T) {
	inputs, err := filepath.Glob("../../internal/planner/testdata/*.input.json")
	if err != nil || len(inputs) == 0 {
		t.Fatalf("no fixtures: %v", err)
	}
	for _, path := range inputs {
		name := strings.TrimSuffix(filepath.Base(path), ".input.json")
		t.Run(name, func(t *testing.T) {
			input, err := os.ReadFile(path) // #nosec G304 -- a test fixture
			if err != nil {
				t.Fatal(err)
			}
			want, err := os.ReadFile(strings.Replace(path, ".input.json", ".golden.json", 1)) // #nosec G304 -- a test fixture
			if err != nil {
				t.Fatal(err)
			}
			var got, expected any
			if err := json.Unmarshal([]byte(planJSON(string(input))), &got); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(want, &expected); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, expected) {
				t.Errorf("differs from the golden file\n got: %v\nwant: %v", got, expected)
			}
		})
	}
}

func TestBridgeReportsBadInput(t *testing.T) {
	for name, out := range map[string]string{"plan": planJSON("not json"), "check": checkJSON("not json")} {
		var res failure
		if err := json.Unmarshal([]byte(out), &res); err != nil || res.Error == "" {
			t.Errorf("%s: %q", name, out)
		}
	}
}

func TestBridgeChecksAHandPlacedBlock(t *testing.T) {
	input, err := os.ReadFile("../../internal/planner/testdata/back-to-back-meetings.input.json")
	if err != nil {
		t.Fatal(err)
	}
	mode := `{"name":"Pomodoro","focus_min":25,"rest_min":5}`
	check := func(start string) checkResult {
		t.Helper()
		var res checkResult
		req := `{"input":` + string(input) + `,"start":"` + start + `","mode":` + mode + `}`
		if err := json.Unmarshal([]byte(checkJSON(req)), &res); err != nil {
			t.Fatal(err)
		}
		return res
	}
	if got := check("2026-10-26T09:30:00-04:00"); got.Code != "meeting" || got.At == nil {
		t.Errorf("on a meeting: %+v", got)
	}
	if got := check("2026-10-26T09:31:00-04:00"); got.Code != "off_grid" {
		t.Errorf("off the grid: %+v", got)
	}
}
