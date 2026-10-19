# 0002 — Plain SQL migrations + `node-postgres`

Spec §17.2. Status: accepted, 2026-10-19.

## Decision

Schema changes are numbered SQL files in `packages/api/migrations/`, applied
in order by a ~60-line runner that records applied names in
`schema_migrations`. Queries are hand-written SQL through `pg`.

## Why

- The spec explicitly allows it and discourages heavy ORMs.
- SQL files are reviewable, revertible and readable by operators with `psql`.
- No build-time code generation, no second schema language.

## Consequences

- Migrations are forward-only; a rollback is a new migration.
- Each migration runs in one transaction. Keep them small.
