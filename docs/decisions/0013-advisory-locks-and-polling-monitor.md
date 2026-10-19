# 0013 — Advisory locks per run; Job state by polling

Spec §5.1 items 2–3. Status: accepted deviation, 2026-10-19.

## Decision

- The reconcile loop claims a run with `pg_try_advisory_lock(hashtext(run_id))`
  instead of `SELECT … FOR UPDATE SKIP LOCKED`.
- Job and pod state is read with a list every 10 s (`JobMonitor`) instead of
  a Kubernetes watch.

## Why

- `appendEvents` refreshes the cached columns on `runs` in its own
  transaction. A row lock held by the reconciler blocks that update from
  another pooled connection: the loop deadlocks on itself. An advisory lock
  gives the same "one pass per run at a time, skip if busy" semantics
  without touching the row.
- A watch needs reconnect, resync and bookmark handling to be reliable; a
  list every 10 s over a few dozen Jobs is cheap and has no failure modes.
  The runner reports its own lifecycle events, so the monitor only has to
  catch what the runner cannot say: image pull errors, evictions,
  deadlines and silent exits.

## Consequences

- Latency from pod death to `invocation.failed` is up to the poll interval.
- Advisory locks are per database connection; the reconciler holds one
  pooled client for the duration of a pass and releases both explicitly.
