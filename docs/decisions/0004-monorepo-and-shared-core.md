# 0004 — pnpm monorepo with a shared `@mates/core` library

Status: accepted, 2026-10-19.

## Decision

One repository, pnpm workspaces, four packages: `core`, `api`, `runner`,
`ui`. `core` holds pure domain code (types, projection, validation,
redaction, rendering) and must not import I/O, HTTP, database or framework
modules. It is a library, not a service: the service count stays as in §3.1.

## Why

- §4.3 requires one `projectRun(events)` used by API, UI and tests. A shared
  package is the only way to literally share it.
- §10.3 requires one `redact()` applied in both API and runner.
- Enforced layering: `core` cannot cheat because it has no such dependencies.

## Consequences

- `core` is built first; other packages depend on it through the workspace.
- Domain tests live in `core` and run without a database.
