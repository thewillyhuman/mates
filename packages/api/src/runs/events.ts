import { projectRun, type NewEvent, type RunEvent, type RunProjection } from '@mates/core';
import type pg from 'pg';
import { withTransaction, type Pool, type Queryable } from '../db/pool.js';
import type { EventBus } from './bus.js';

/**
 * The event log. `appendEvents` is the only writer: it inserts the batch,
 * re-projects the run and refreshes the cached columns on `runs`, all in
 * one transaction, then publishes to the bus.
 */

interface EventRow {
  id: string;
  run_id: string;
  invocation_id: string | null;
  ts: Date;
  type: string;
  payload: unknown;
}

function toEvent(r: EventRow): RunEvent {
  return {
    id: Number(r.id),
    run_id: r.run_id,
    invocation_id: r.invocation_id,
    ts: r.ts.toISOString(),
    type: r.type,
    payload: r.payload,
  } as RunEvent;
}

export async function listEvents(
  db: Queryable,
  runId: string,
  opts: { after?: number; limit?: number } = {},
): Promise<RunEvent[]> {
  const r = await db.query<EventRow>(
    `SELECT id, run_id, invocation_id, ts, type, payload FROM events
     WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [runId, opts.after ?? 0, opts.limit ?? 10_000],
  );
  return r.rows.map(toEvent);
}

/** Current projection of a run, from its full log. */
export async function projectRunById(db: Queryable, runId: string): Promise<RunProjection> {
  return projectRun(await listEvents(db, runId));
}

/** Tail lines are capped per invocation (§17.4); this is how many exist so far. */
export async function countTailEvents(db: Queryable, invocationId: string): Promise<number> {
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events
     WHERE invocation_id = $1 AND type IN ('invocation.tool_use', 'invocation.text')`,
    [invocationId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function insertEvents(
  client: pg.PoolClient,
  runId: string,
  events: readonly NewEvent[],
): Promise<RunEvent[]> {
  const inserted: RunEvent[] = [];
  for (const e of events) {
    const r = await client.query<EventRow>(
      `INSERT INTO events (run_id, invocation_id, ts, type, payload)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()), $4, $5)
       RETURNING id, run_id, invocation_id, ts, type, payload`,
      [runId, e.invocation_id ?? null, e.ts ?? null, e.type, JSON.stringify(e.payload)],
    );
    inserted.push(toEvent(r.rows[0]!));
  }
  return inserted;
}

/** Event types that cannot change the projection's cached columns. */
const TAIL_TYPES = new Set(['invocation.heartbeat', 'invocation.tool_use', 'invocation.text']);

async function refreshRunCache(client: pg.PoolClient, runId: string): Promise<RunProjection> {
  const p = projectRun(await listEvents(client, runId));
  await client.query(
    `UPDATE runs SET status = $2, iteration = $3, finished_at = $4, paused = $5,
       mr_id = $6, mr_url = $7, mr_state = $8, base_branch = COALESCE($9, base_branch)
     WHERE id = $1`,
    [
      runId,
      p.stage,
      p.iteration,
      p.finishedAt,
      p.paused,
      p.mr?.id ?? null,
      p.mr?.url ?? null,
      p.mr ? (p.mr.draft ? 'draft' : 'ready') : null,
      p.intake?.base_branch ?? null,
    ],
  );
  return p;
}

export interface AppendResult {
  events: RunEvent[];
  projection: RunProjection | null;
}

/**
 * Appends `events` to `runId`. Returns the stored events and, unless the
 * batch was tail-only, the fresh projection.
 */
export async function appendEvents(
  pool: Pool,
  bus: EventBus,
  runId: string,
  events: readonly NewEvent[],
): Promise<AppendResult> {
  if (events.length === 0) return { events: [], projection: null };
  const result = await withTransaction(pool, async (client) => {
    const stored = await insertEvents(client, runId, events);
    const tailOnly = events.every((e) => TAIL_TYPES.has(e.type));
    const projection = tailOnly ? null : await refreshRunCache(client, runId);
    return { events: stored, projection };
  });
  bus.publish(runId, result.events);
  return result;
}

/** Same as `appendEvents` but inside a caller-owned transaction; no publish. */
export async function appendEventsTx(
  client: pg.PoolClient,
  runId: string,
  events: readonly NewEvent[],
): Promise<AppendResult> {
  const stored = await insertEvents(client, runId, events);
  const tailOnly = events.every((e) => TAIL_TYPES.has(e.type));
  const projection = tailOnly ? null : await refreshRunCache(client, runId);
  return { events: stored, projection };
}
