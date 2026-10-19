# M5 — Cost ledger

Spec: §9 (token usage and cost), §12 (`GET /stats`), §13.1 (stats strip),
§13.4 (Usage page data), §15.2 (M5).

## Goal

Every invocation's usage is captured from its final `result`, priced from
the operator's table, compared with Claude Code's own figure, rolled up
by every dimension the UI needs, and exposed at `GET /api/stats`. The
daily budget shows as a banner with its reset time, and the Jira comment
at readiness carries the cost line.

## Plan

1. **core**: `computeCost(usage, price)` and `costDiscrepancy(reported,
   computed)` (the > 10 % flag of §9.1), pure and tested.
2. **Ledger**: on `invocation.finished` the orchestrator already emits
   `usage.recorded`; M5 also writes the `usage` row (`cost_usd_reported`,
   `cost_usd_computed` from the pricing table, null when the model is
   unpriced) and the per-model breakdown from `modelUsage` when present.
3. **Rollups** (`GET /api/stats?from=&to=&group_by=`): on-the-fly SQL
   over `usage` and `runs` for cost and tokens per day/week/month, per
   mate, per model, per run, per ticket, per repo and per Jira project;
   cost per successful MR; iterations-to-approval histogram; p50/p90 run
   duration.
4. **Board strip** (`GET /api/stats/board`): running by stage, waiting on
   a human, MRs opened today, average iterations to approval over 7 days,
   spend today in tokens and USD with the per-ticket average, and the
   daily-budget banner (`exceeded`, `limit`, `spent`, `resets_at`).
5. **Settings**: `GET/PUT /api/settings/pricing` (§9.3) with the "fill in
   from Anthropic's price list" hint; prices are never shipped in the repo.
6. **Jira**: the §9.5 cost line (already in M4) switches to the computed
   cost when the reported one is missing.
7. **Tests**: pricing unit tests, ledger rows from fixture results,
   rollups against seeded runs, banner on and off.

## Out of scope

Charts and the Usage page itself (M6); retention jobs (M7).

## What changed from the plan

- `usage.recorded.cost_usd` falls back to the computed cost when Claude
  Code reported none, so the projection, the budgets and the Jira cost
  line keep working with providers that report no cost.
- The per-model breakdown (`modelUsage`) yields one ledger row per model;
  the event sums them and names the invocation's model.
- Rollups are plain SQL on the fly (no materialised views): one row per
  invocation keeps them cheap at v1 volumes; `GROUP BY` expressions are
  a table keyed by `group_by`, so adding a dimension is one line.
- `GET /api/stats/outcomes` carries the run-level figures (runs by
  outcome, cost per done MR, iterations-to-approval histogram, p50/p90
  duration) separately from the usage buckets.
- `SettingsService.replaceSection` was added: merging `{}` can never
  remove a key, which the pricing table and the prompt reset need. The
  prompt reset was silently not persisted before.
