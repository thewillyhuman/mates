# Fake Claude fixtures

`<scenario>.jsonl` files replay through `mates-run` when `MATES_FAKE_CLAUDE=1`
(§15.1, Appendix A). They follow the Claude Code 2.1.303 `stream-json`
envelope (`system/init`, `assistant` with `message.usage`, `user` tool
results, `system/api_retry`, final `result` with `usage`, `modelUsage`,
`total_cost_usd`, `is_error`, `permission_denials`, `structured_output`).

The envelopes were captured from a real `claude --bare -p … --output-format
stream-json --verbose` run; the content (tool calls, texts, verdicts, costs)
is authored to tell the story of each scenario. `<scenario>.patch` is applied
to the workspace by the runner so `git diff` is non-empty where the scenario
says so; patches target `test/e2e/seed-repo` and apply in order
(`impl_iter1_green`, then `impl_iter2_addressed`).

| Scenario | Mate | Outcome |
| --- | --- | --- |
| intake_implementable | intake | `implementable`, repo `webhook-service` |
| intake_needs_clarification | intake | one concrete question |
| impl_iter1_green | implementer | edits + green tests, patch 1 |
| impl_iter2_addressed | implementer | addresses B1/B2, skips N3, patch 2 |
| review_changes_requested_2_blocking | reviewer | 2 blocking, 3 non-blocking |
| review_approve | reviewer | approve, 1 nit |
| impl_empty_diff | implementer | no patch, no changes |
| impl_budget_exceeded | implementer | `is_error`, `error_max_budget_usd` |
| api_retry_then_success | intake | two `api_retry` lines, then success |

Regenerate with `python3 scripts/gen-claude-fixtures.py` after editing it.
