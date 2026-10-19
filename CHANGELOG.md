# Changelog

All notable changes to Mates. Format: one entry per milestone, newest first.

## Unreleased

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
