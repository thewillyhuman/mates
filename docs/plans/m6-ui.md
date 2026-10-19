# M6 — UI

Spec: §13 (web UI), §6.2 (wizard), §12 (API surface the pages use),
§15.2 (M6), the two mockups in `docs/mockups/`.

## Goal

The Board and the Ticket detail match the mockups and update live over
SSE; the Settings wizard covers every §6.2 step with a working "Test"
button; the Usage, Mates and Tickets pages exist; Playwright covers the
board, the detail timeline, a nudge and the wizard.

## Plan

1. **API additions the pages need**: `GET /api/tickets` (+ `.csv`) with
   the latest run per ticket and filters, `GET /api/tickets/{key}`, users
   and personal API tokens (bearer auth for scripts, §10.4), the Anthropic
   "Test" as a short-lived Job (§6.2 step 1), and an OpenAPI dump script
   so the UI client is generated from the document (§12).
2. **Foundation**: generated types from OpenAPI, a typed fetch client, an
   SSE hook with reconnect and cursor, design tokens from the mockup
   (IBM Plex, blue/green/amber), small components (stat tile, chip,
   iteration bar, stepper, timeline, live tail, dialog, tabs, forms).
3. **Board** (§13.1): header counters, stats strip from `/api/stats/board`,
   the "Needs a human" lane, six columns with live cards, the daily-budget
   banner, merged-this-week footer when the data exists.
4. **Run detail** (§13.2): header chips and controls (pause/resume, retry,
   cancel with confirm, workspace download of diff + logs), the stepper,
   the timeline with Events / Diff per iteration / Raw log tabs, the live
   tail with Follow, run facts, the nudge composer, older runs.
5. **Tickets** (§13.3), **Usage** (§13.4, hand-written SVG charts, decision
   0016), **Mates** (§13.5), **Settings** (§13.6) with the wizard steps as
   tabs, Helm-managed badges, Users, API tokens, Prompts, Pricing; Audit
   log arrives with M7.
6. **Behaviour** (§13.7): SSE everywhere with backoff, `/` focuses search,
   `Esc` closes dialogs, real buttons and labels, 1024 px layout.
7. **Playwright**: a global setup starts Postgres and the API in fake-jobs
   mode and drives runs through the internal endpoint; tests for the
   board, the detail timeline, a nudge and the wizard. CI runs them.

## Out of scope

Audit log and OIDC sign-in (M7), phone layout (may).

## What changed from the plan

- The UI client is generated from the OpenAPI document (`pnpm --filter
  mates-ui generate:api` dumps it from the app without a server and runs
  openapi-typescript); the run projection is typed through `@mates/core`
  because the API serves `projectRun`'s output as-is.
- The header counters and the board share one global SSE subscription
  through a `BoardProvider`; the detail page keeps its own per-run stream
  with the cursor of the last event it holds.
- The Usage charts stack per-day totals by the overall mate/model shares
  because the stats endpoint rolls up one dimension at a time; a two-
  dimensional rollup is a small follow-up if the approximation misleads.
- A finished run without a merge request (no SCM token configured) is
  listed in the board's weekly footer rather than the "MR open" column.
- Fetching the team context from a git URL is deferred to M7 with the
  provider archive endpoints; the tab saves the URL and ref already.
- Two product defects surfaced by the browser tests: cancelling a run did
  not record the end of its live invocation (the projection kept it
  "running"), and the prompt reset was not persisted. Both are fixed with
  tests.
- Browser tests run against the real API process (fake jobs, fake Claude,
  memory secrets) on a testcontainers Postgres; runs are driven through
  the internal ingest endpoint with JWTs minted by the test, so the pages
  see real projections and real SSE.
