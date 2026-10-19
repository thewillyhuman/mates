# M4 — The loop

Spec: §7.5 (orchestrator rules), §8.2 (clarification round-trip), §8.3
(MR content), §9.4 (budgets), §12 (`pause|resume|cancel|retry`, nudges),
§15.2 (M4).

## Goal

A ticket goes from `queued` to a reviewed merge request with no human in
the loop: intake → implementer → reviewer → iterate → `mr_ready`/`done`,
or `blocked` with the draft MR and the unresolved points when the cap is
hit. Humans can pause, resume, cancel, retry and nudge. Every rule of
§7.5 has a test, and the five fake-Claude scenarios of §15.2 run end to
end on kind.

## Plan

1. **core**: `tracker.transition_skipped` and `run.budget_changed`
   events; the projection records `resumedFrom` (which block a human
   retried out of) and applies budget changes.
2. **Decision table** (`orchestrator/reconciler.ts`): the next action is
   derived from the projection alone, so restarts and resumes need no
   special state:
   - no intake result → run intake (unless the clarification limit is hit);
   - intake `implementable` → `intake.passed`, repo on the ticket,
     implementer 1; `needs_clarification` → Jira comment, `blocked`;
     `out_of_scope` → `failed`;
   - implementer pushed with changes → open the draft MR (first time) or
     refresh its description, then reviewer n; no changes → synthetic
     `changes_requested` once, `failed` the second time (rule 5);
   - reviewer `approve` → description, mark ready, Jira transition and
     comment, `mr_ready` → `done` (rule 2); `changes_requested` →
     implementer n+1 with the verdict and unconsumed nudges, or `blocked`
     at the cap with the unresolved points in the MR (rules 3, 4, 9);
   - Claude's own budget stop (`error_max_budget_usd`) and the per-run
     budget → `run.budget_exceeded`, `blocked`; the daily budget keeps
     runs `queued` (rule 7, §9.4);
   - paused runs finish the current invocation and wait (rule 8);
   - infra failures retry once (rule 6, from M2).
3. **Side effects**: `MergeRequests` (open/update/mark ready through the
   `Scm` port with the §8.3 renderer) and `TrackerSync` (status map
   transitions, stage and cost comments, clarification questions).
4. **HTTP**: `POST /runs/{id}/pause|resume|retry`, `POST /runs/{id}/nudges`
   (`text`, `post_to_tracker`, `and_retry`), `retry` accepting a raised
   `budget_usd`.
5. **Tests**: loop scenarios driven by the fixtures' `result` lines through
   the ingest endpoint with fake Jobs, tracker and SCM: approve on 1,
   approve on 3, cap at 4, clarification then answered, empty diff twice,
   budget block and raise, pause/resume, nudge consumption, Jira
   transitions and comments, MR draft → ready.
6. **e2e**: the same scenarios on kind against Gitea, asserting the
   branch, the pull request state and the event log.

## Out of scope

Cost computation from the pricing table and the stats endpoint (M5);
notifications (M7).

## What changed from the plan

- The next action is derived from the projection on every pass, with a
  single `outcomeRecorded` flag per invocation (set by the orchestrator's
  own events) separating "result not yet processed" from "waiting". A
  non-zero Claude exit with a result (budget stop, API error) is a result
  to process, not an infrastructure failure.
- An iteration whose implementer stopped without changes and without a
  verdict (a budget stop) is re-run for the same iteration number after a
  resume; an empty diff gets the synthetic verdict of rule 5 instead.
- `queued → blocked` was added to the transition table for the budget
  check that runs before the first spawn after a resume (decision 0015).
- Nudges are consumed at spawn time and the brief carries the nudges
  consumed by that invocation, so a restart between spawn and bundle
  download cannot lose or duplicate them.
- In fake mode the runner appends a marker line to `README.md` when a
  scenario's patch no longer applies (the same fixture replayed on a later
  iteration), so the kind e2e can run "approve on iteration 3".
- The daily budget check keeps a run in its current stage without
  spawning; the banner and the rollups come with M5.
- The chart's `config` block is empty by default. Shipping the spec's
  defaults there made every setting Helm-managed out of the box, so the
  settings UI (and the e2e's iteration cap) could never change them; the
  API carries the same defaults and operators pin keys deliberately.
- Verified on kind through real runner pods against Gitea: approve on 1
  (pull request ready, branch pushed), approve on 3, cap with the draft
  and the unresolved points, clarification answered through a nudge,
  empty diff twice → failed.
