# 0007 — In-process event bus, single API replica

Spec §5.1 (fan-out), §17.4, §17.5. Status: accepted, 2026-10-19.

## Decision

Live fan-out (SSE per run and for the board) is an in-process
`EventEmitter` fed after every committed append. `mates-api` runs as one
replica (`replicaCount: 1`, `strategy: Recreate`) in v1. Live-tail lines
(`invocation.tool_use`, `invocation.text`) are persisted as events, capped
per invocation (§17.4), so a reconnecting client replays from a cursor.

## Why

- The spec allows a single replica for v1 and prefers events over a ring
  buffer for replay.
- No extra moving parts: Postgres is the log, memory is the fan-out.
- A client that reconnects passes `after=<event id>` and misses nothing,
  which is what makes the single-process bus acceptable.

## Consequences

- Scaling to several replicas later needs either Postgres `LISTEN/NOTIFY`
  or an advisory-lock leader (§17.5); the bus interface is the seam.
- A restart drops open SSE connections; the UI reconnects with backoff
  and its last cursor (§13.7).
