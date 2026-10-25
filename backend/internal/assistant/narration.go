package assistant

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	clockRe = regexp.MustCompile(`(?i)\b([01]?\d|2[0-3]):([0-5]\d)(\s*([ap])\.?\s?m\b)?`)
	hourRe  = regexp.MustCompile(`(?i)\b(1[0-2]|0?[1-9])\s*([ap])\.?\s?m\b`)
	wordRe  = regexp.MustCompile(`(?i)\b(noon|midday|midnight)\b`)
)

// mention is one time named in prose, as the minutes after midnight it could mean. A
// bare "2:30" could be 02:30 or 14:30, so it carries both.
type mention struct {
	text    string
	minutes []int
}

// mentions finds every clock time in text: "14:30", "2:30 pm", "2pm", "9 a.m.", "noon".
func mentions(text string) []mention {
	var out []mention
	rest := text
	for _, m := range clockRe.FindAllStringSubmatch(text, -1) {
		h, _ := strconv.Atoi(m[1])
		min, _ := strconv.Atoi(m[2])
		out = append(out, mention{m[0], hours(h, strings.ToLower(m[4]), true, min)})
		rest = strings.Replace(rest, m[0], " ", 1) // so "10:30 am" isn't read again as "30 am"
	}
	for _, m := range hourRe.FindAllStringSubmatch(rest, -1) {
		h, _ := strconv.Atoi(m[1])
		out = append(out, mention{m[0], hours(h, strings.ToLower(m[2]), false, 0)})
	}
	for _, m := range wordRe.FindAllString(rest, -1) {
		if strings.EqualFold(m, "midnight") {
			out = append(out, mention{m, []int{0}})
		} else {
			out = append(out, mention{m, []int{12 * 60}})
		}
	}
	return out
}

func hours(h int, suffix string, colon bool, min int) []int {
	switch {
	case suffix == "a":
		return []int{(h%12)*60 + min}
	case suffix == "p":
		return []int{(h%12+12)*60 + min}
	case colon && (h == 0 || h >= 13 || h == 12):
		return []int{h*60 + min}
	}
	return []int{h*60 + min, (h+12)*60 + min} // "2:30" alone: either half of the day
}

// inventedTime returns the first time the narration mentions that appears in no tool
// result the model saw, or "" if every time it names came from one.
func inventedTime(narration string, allowed map[int]bool) string {
	for _, m := range mentions(narration) {
		ok := false
		for _, minute := range m.minutes {
			ok = ok || allowed[minute]
		}
		if !ok {
			return strings.TrimSpace(m.text)
		}
	}
	return ""
}
