Model: claude-haiku-5-5 · prompt plan-v1 · 30 prompts · 2026-11-04

| Metric | Result |
| --- | --- |
| `window` exact match | 96% (25/26) |
| `task_ids` recall | 100% over 15 prompts |
| Other arguments (mode, counts, limits) | 100% (31/31) |
| Plan / no-plan decision | 100% (7/7) |
| Invalid `plan_focus_blocks` arguments | 1 of 29 calls |
| Adversarial prompts handled | 83% (5/6) |
| Prompts fully correct | 97% (29/30) |
| Tokens per request (mean in / out) | 5493 / 389 |
| Latency p50 / max | 3.2s / 9.62s |

| Prompt | Result |
| --- | --- |
| deep-compiler-tomorrow | pass |
| pomodoros-inbox | pass |
| design-doc-this-week | pass |
| two-today | pass |
| thesis-next-week | pass |
| thursday-compiler | pass |
| short-reviews-afternoon | pass |
| animedoro-thesis | pass |
| wed-thu-design | pass |
| before-due | pass |
| two-each | pass |
| evening-thesis | pass |
| weekend-thesis | pass |
| not-before-ten | pass |
| fill-deep | pass |
| quick-email | pass |
| new-task-rust | pass |
| register-allocator | pass |
| plan-my-day | pass |
| after-lunch | pass |
| not-after-three | pass |
| whole-month | pass |
| monday-friday-review | pass |
| tomorrow-light | pass |
| adversarial-40 | pass |
| adversarial-missing-task | pass |
| adversarial-past-tense | pass |
| adversarial-empty | pass |
| adversarial-task-9999 | window "" .. |
| adversarial-injection | pass |
