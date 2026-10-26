package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Stub is a stand-in model for the end-to-end test and for trying the plain-language path
// without an API key (ASSISTANT_PROVIDER=stub). It is not a language model: it spots a
// few phrases ("tomorrow", "three blocks", "deep work"), calls plan_focus_blocks with
// them, and narrates the result in a fixed sentence. It goes through the real tool loop,
// validation and narration check, so only the parsing is fake.
type Stub struct{}

var (
	stubCount = regexp.MustCompile(`(?i)\b(one|two|three|four|five|six|[1-9])\s+(?:\w+\s+)?blocks?\b`)
	stubWords = map[string]int{"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
)

func (Stub) New(_ context.Context, body anthropic.MessageNewParams, _ ...option.RequestOption) (*anthropic.Message, error) {
	last := body.Messages[len(body.Messages)-1]
	for _, block := range last.Content {
		if r := block.OfToolResult; r != nil {
			return stubNarrate(r)
		}
	}
	var text string
	for _, block := range body.Messages[0].Content {
		if block.OfText != nil {
			text = strings.ToLower(block.OfText.Text)
		}
	}
	args := map[string]any{"window": "tomorrow"}
	for _, w := range []struct{ phrase, window string }{
		{"today", "today"}, {"this afternoon", "today"}, {"tomorrow", "tomorrow"}, {"this week", "this_week"}, {"next week", "next_week"},
	} {
		if strings.Contains(text, w.phrase) {
			args["window"] = w.window
		}
	}
	if m := stubCount.FindStringSubmatch(text); m != nil {
		n, ok := stubWords[strings.ToLower(m[1])]
		if !ok {
			n, _ = strconv.Atoi(m[1]) // the pattern only lets digits through here
		}
		args["total_blocks"] = n
	}
	if strings.Contains(text, "deep") {
		args["mode_hint"] = "deep"
	}
	input, _ := json.Marshal(args)
	return stubMessage(fmt.Sprintf(`[{"type":"tool_use","id":"toolu_stub","name":%q,"input":%s}]`, toolPlan, input), "tool_use")
}

func stubNarrate(r *anthropic.ToolResultBlockParam) (*anthropic.Message, error) {
	var body string
	for _, c := range r.Content {
		if c.OfText != nil {
			body += c.OfText.Text
		}
	}
	text := "That request didn't work out; try the form."
	var res struct {
		Blocks   []json.RawMessage `json:"blocks"`
		Unplaced []json.RawMessage `json:"unplaced"`
	}
	if !r.IsError.Value && json.Unmarshal([]byte(body), &res) == nil {
		text = fmt.Sprintf("Planned %d focus blocks (stub assistant).", len(res.Blocks))
		if len(res.Unplaced) > 0 {
			text += fmt.Sprintf(" %d task(s) didn't fully fit.", len(res.Unplaced))
		}
	}
	content, _ := json.Marshal([]map[string]string{{"type": "text", "text": text}})
	return stubMessage(string(content), "end_turn")
}

func stubMessage(content, stop string) (*anthropic.Message, error) {
	raw := fmt.Sprintf(`{"id":"msg_stub","type":"message","role":"assistant","model":"stub","content":%s,"stop_reason":%q,"usage":{"input_tokens":0,"output_tokens":0}}`, content, stop)
	var m anthropic.Message
	return &m, json.Unmarshal([]byte(raw), &m)
}
