# Changelog

All notable changes to Mates. Format: one entry per milestone, newest first.

## Unreleased

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
