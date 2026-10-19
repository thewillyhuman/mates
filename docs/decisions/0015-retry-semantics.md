# 0015 — What "retry" means for a blocked run

Spec §4.2 (`blocked → queued`), §7.5 rules 4, 7 and 9. Status: accepted,
2026-10-19.

## Decision

`POST /runs/{id}/retry` (and a nudge with `and_retry`) moves a `blocked`
run to `queued`. What happens next depends on why it was blocked:

| Blocked by | After retry |
| --- | --- |
| `needs_clarification` | intake runs again with the full comment thread |
| `iteration_cap` | one more implementer iteration is allowed (n+1), then the reviewer; a second `changes_requested` blocks again |
| `budget_exceeded` | the pending step resumes; `retry` may carry a raised `budget_usd`, recorded as `run.budget_changed` |

Intake is never repeated once it passed. Retrying is only possible from
`blocked`; `failed` and `cancelled` are terminal, and a new run for the
same ticket is the way forward there.

## Why

- The spec leaves the post-cap behaviour open; allowing exactly one more
  iteration per human decision keeps the cap meaningful while letting a
  nudge ("use the shared helper") unblock a run that was close.
- Raising the budget on retry is the action §7.5 rule 7 describes
  ("so a human can raise the budget and retry") without a settings change
  that would affect every other run.

## Consequences

- The next action is derived from the projection, including
  `resumedFrom`, so restarts of the API never lose this context.
- The transition table gains `queued → implementing`, `queued → reviewing`
  (resume without repeating intake) and `queued → blocked` (the budget
  check before the first spawn after a resume).
