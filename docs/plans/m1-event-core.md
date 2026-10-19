# M1 — Event core

Spec: §4 (domain model, state machine, event types), §5.1 items 4–5, §12
(`POST /runs`, `/runs/{id}/events`, `/runs/{id}/stream`, `/stream`,
`/internal/invocations/{id}/events`), §15.2 (M1).

## Goal

The event log exists, is the only source of truth, and everything that
reads run state does so through one `projectRun(events)`. Runners can push
events with a per-invocation JWT; the UI can follow a run and the board live
over SSE; an operator can start a run by hand.

## Plan

1. **`packages/core`** (`@mates/core`, pure): `Stage`, the transition table
   from §4.2 with `assertTransition`, zod schemas for every event type in
   §4.3 (plus `run.paused`/`run.resumed`, needed by §7.5 rule 8), the
   derived `RunEvent` union, and `projectRun(events): RunProjection`.
   Unit tests: every legal transition, every illegal one, and projection
   scenarios (happy path, iteration loop, blocked at cap, clarification,
   cancel, budget, usage totals, nudges).
2. **Tables** (migration `0002`): `tickets`, `runs`, `invocations`,
   `events`, `verdicts`, `nudges`, `usage`, `settings`. `runs.status` is a
   cache of the projection kept in step on every append; it exists for the
   board query and the reconcile loop's `FOR UPDATE SKIP LOCKED`, never as a
   second source of truth.
3. **Repositories** (`packages/api/src/runs/`): `appendEvents` (one
   transaction: insert events, refresh `runs.status`/`iteration`, publish to
   the in-process bus), `createRun` (idempotent per active ticket),
   `getRun`, `listRuns`, `listEvents(after)`.
4. **Invocation JWT** (`packages/api/src/auth/invocation-token.ts`): HS256
   with the internal key, `aud=mates-runner`, `sub=<invocation id>`,
   `exp = timeout + 10 min` (§10.2).
5. **HTTP**: `POST /internal/invocations/{id}/events` (JWT; batch; events
   validated with the core schemas), `GET /api/runs`, `GET /api/runs/{id}`,
   `GET /api/runs/{id}/events?after=`, `GET /api/runs/{id}/stream` (SSE,
   replays after cursor then live), `GET /api/stream` (SSE board updates),
   `POST /api/runs { ticket_key }` (operator).
6. **Event bus**: in-process `EventEmitter` fed after each commit
   (decision 0007). SSE handlers subscribe per run or globally.

## Out of scope

The reconcile loop (M4), Jobs (M2), adapters (M3). `POST /runs` therefore
creates a ticket placeholder when no tracker is configured; intake fills it
in later.

## What changed from the plan

- `run.created` carries `max_iterations` and `budget_usd` so the projection
  is self-contained; `nudge.added` carries the nudge text so the timeline
  needs no join.
- `invocation.finished` carries the (redacted) final `result` message from
  Claude Code. The orchestrator derives `usage.recorded`, `review.verdict`
  and the intake outcome from it (M4/M5); runners never emit those types and
  the ingest endpoint rejects them.
- `queued → implementing` was added to the transition table so a run
  blocked after intake (cap, budget) can resume without repeating intake.
- The live tail is capped at 5 000 lines per invocation in the ingest
  endpoint; one marker line is appended when the cap is crossed.
- The board stream coalesces bursts into one summary per run per 300 ms.
- Tests resolve `@mates/core` from its sources through a vitest alias;
  `pnpm typecheck`/`pnpm test` build core first for the `dist`-based
  resolution tsc uses.
