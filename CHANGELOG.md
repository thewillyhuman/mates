# Changelog

All notable changes to Mates. Format: one entry per milestone, newest first.

## Unreleased

### M7 — Hardening

- Audit log of every settings, credential, user, token and run action
  (`GET /api/settings/audit`, Settings → Audit log).
- Prometheus metrics at `/metrics` (§14), a daily retention job for
  transcripts and finished runs, Slack-compatible webhook notifications.
- Team context fetched from a repository on a configured provider through
  its archive API, refreshed every five minutes or on demand.
- OIDC sign-in (authorization code + PKCE) with group → role mapping; the
  first OIDC user on an empty instance becomes admin.
- GitHub App authentication per provider: installation tokens minted from
  the App's private key, cached, and handed to runners through the
  per-invocation Secret.
- Chart: NetworkPolicies, `values.schema.json`, OIDC values; the kind e2e
  runs under Pod Security `restricted`.
- `docs/operations.md` and a ten-minute README quickstart.

### M6 — UI

- Board and ticket detail after the mockups, live over SSE: stats strip,
  "needs a human" lane, six columns, stepper, timeline with verdicts,
  diff per iteration, raw log, live tail, run facts, nudge composer,
  pause/resume/retry/cancel.
- Tickets table with filters and CSV export; Usage page with hand-written
  SVG charts; Mates page; Settings wizard with all "Test" buttons,
  Helm-managed badges, users, API tokens, prompts, pricing, checklist.
- API additions: tickets endpoints, users and personal API tokens (bearer
  auth), the Anthropic test Job, an OpenAPI dump for client generation.
- Playwright tests for the board, the detail timeline, a nudge and the
  wizard, run in CI.

### M5 — Cost ledger

- `computeCost` / `costDiscrepancy` in `@mates/core`; ledger rows per
  invocation and model with reported and computed cost.
- `GET /api/stats` (per day/week/month/mate/model/run/ticket/repo/project),
  `GET /api/stats/outcomes`, `GET /api/stats/board` with the daily-budget
  banner; `GET/PUT /api/settings/pricing`.
- Settings sections can be replaced wholesale (pricing table, prompt reset).

### M4 — The loop

- Full §7.5 decision table: intake outcomes, implementer → reviewer
  iterations with the draft MR opened on the first push and refreshed after
  each one, approval → ready → done, cap → blocked with unresolved points,
  empty diffs, budget stops, infra retries, clarification round-trip with
  a three-round limit.
- Jira status-map transitions and comments on clarification, readiness,
  cap, budget and failure; `tracker.transition_skipped` when the map asks
  for an unavailable transition.
- `POST /api/runs/{id}/pause|resume|retry` (retry may raise the budget),
  `POST /api/runs/{id}/nudges` with tracker echo and "and retry".
- Loop tests for all five §15.2 scenarios plus budget, pause and nudges;
  the kind e2e runs them against Gitea.
- Chart: `config` is empty by default so settings are UI-managed unless
  pinned in values.

### M3 — Adapters

- `Tracker` and `Scm` ports with in-memory fakes; Jira (Cloud + Data
  Center, ADF ↔ markdown), GitLab, GitHub (draft fallback, GraphQL mark
  ready) and Gitea adapters with recorded HTTP fixtures.
- `POST /webhooks/jira`, JQL polling, ticket enrichment on every trigger,
  clarification round-trip re-queue, credential "Test" endpoints.
- MR title and description renderer (§8.3) in `@mates/core`.

### M2 — Runner + Jobs

- `mates-run`: context download, clone through a credential helper, setup
  with timeout, Claude Code with the §7.3 flags (or a fixture in fake mode),
  condensed live-tail events, commit/push guarded to `mates/*` branches,
  test-output parsing, blob upload, redaction, SIGTERM handling.
- `@mates/core`: `redact`, `mates.yaml` validation, branch/commit naming,
  test-output parsers, the invocation context contract, mate output schemas.
- `mates-api`: settings with Helm precedence, credentials in the release
  Secret, team-context upload and validation, prompt templates, context
  bundle builder, Kubernetes Job spawner with per-invocation token Secrets,
  Job monitor, retry-once supervisor, cancel, blob and context endpoints.
- Fake-Claude fixtures for the nine Appendix A scenarios; e2e on kind with
  Gitea.

### M1 — Event core

- `@mates/core`: stages and the §4.2 state machine, zod schemas for every
  event type, `projectRun(events)`.
- Tables for tickets, runs, invocations, events, verdicts, nudges, usage and
  settings.
- `POST /internal/invocations/{id}/events` with per-invocation JWTs and a
  5 000-line live-tail cap.
- `GET /api/runs`, `/api/runs/{id}`, `/api/runs/{id}/events`, SSE at
  `/api/runs/{id}/stream` and `/api/stream`, `POST /api/runs` manual trigger.

### M0 — Skeleton

- pnpm workspace with `core`, `api`, `runner`, `ui` packages.
- `mates-api`: config, logging, migrations, `/healthz`, `/readyz`,
  bootstrap token, first-admin setup, local login.
- Container images for `mates-api` and `mates-runner`.
- Helm chart with bundled Postgres; installs on `kind`.
- CI: lint, typecheck, unit tests, chart lint, kind smoke test.
