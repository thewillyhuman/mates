import type { Mate } from '@mates/core';
import { withTransaction, type Pool, type Queryable } from '../db/pool.js';
import type { EventBus } from './bus.js';
import { appendEventsTx } from './events.js';

/** Invocation rows: one per Claude Code execution (§4.1). */

export type InvocationStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface Invocation {
  id: string;
  runId: string;
  seq: number;
  mate: Mate;
  iteration: number;
  status: InvocationStatus;
  jobName: string;
  podName: string | null;
  model: string;
  attempt: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  sessionId: string | null;
  createdAt: Date;
}

interface Row {
  id: string;
  run_id: string;
  seq: number;
  mate: Mate;
  iteration: number;
  status: InvocationStatus;
  k8s_job_name: string;
  pod_name: string | null;
  model: string;
  attempt: number;
  started_at: Date | null;
  finished_at: Date | null;
  exit_code: number | null;
  claude_session_id: string | null;
  created_at: Date;
}

const columns =
  'id, run_id, seq, mate, iteration, status, k8s_job_name, pod_name, model, attempt, started_at, finished_at, exit_code, claude_session_id, created_at';

function toInvocation(r: Row): Invocation {
  return {
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    mate: r.mate,
    iteration: r.iteration,
    status: r.status,
    jobName: r.k8s_job_name,
    podName: r.pod_name,
    model: r.model,
    attempt: r.attempt,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    exitCode: r.exit_code,
    sessionId: r.claude_session_id,
    createdAt: r.created_at,
  };
}

/** Deterministic Job name: `mates-r{run_short}-i{seq}-{mate}[-r{attempt}]`, ≤ 63 chars (§7.2). */
export function jobName(runId: string, seq: number, mate: Mate, attempt = 0): string {
  const short = runId.replace(/-/g, '').slice(0, 8);
  const base = `mates-r${short}-i${seq}-${mate}`;
  return attempt > 0 ? `${base}-r${attempt}` : base;
}

export interface NewInvocation {
  runId: string;
  mate: Mate;
  iteration: number;
  model: string;
  attempt?: number;
}

/**
 * Allocates the next `seq` for the run, inserts the invocation and appends
 * `invocation.scheduled` in one transaction.
 */
export async function createInvocation(
  pool: Pool,
  bus: EventBus,
  input: NewInvocation,
): Promise<Invocation> {
  const result = await withTransaction(pool, async (client) => {
    // Serialise seq allocation per run by locking the run row.
    await client.query('SELECT id FROM runs WHERE id = $1 FOR UPDATE', [input.runId]);
    const next = await client.query<{ seq: number }>(
      'SELECT COALESCE(max(seq), 0) + 1 AS seq FROM invocations WHERE run_id = $1',
      [input.runId],
    );
    const seq = next.rows[0]?.seq ?? 1;
    const attempt = input.attempt ?? 0;
    const name = jobName(input.runId, seq, input.mate, attempt);
    const r = await client.query<Row>(
      `INSERT INTO invocations (run_id, seq, mate, iteration, status, k8s_job_name, model, attempt)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7) RETURNING ${columns}`,
      [input.runId, seq, input.mate, input.iteration, name, input.model, attempt],
    );
    const inv = toInvocation(r.rows[0]!);
    const { events } = await appendEventsTx(client, inv.runId, [
      {
        type: 'invocation.scheduled',
        payload: {
          mate: inv.mate,
          iteration: inv.iteration,
          job_name: inv.jobName,
          model: inv.model,
        },
        invocation_id: inv.id,
      },
    ]);
    return { inv, events };
  });
  bus.publish(result.inv.runId, result.events);
  return result.inv;
}

export async function findInvocation(db: Queryable, id: string): Promise<Invocation | undefined> {
  const r = await db.query<Row>(`SELECT ${columns} FROM invocations WHERE id = $1`, [id]);
  return r.rows[0] ? toInvocation(r.rows[0]) : undefined;
}

export async function listInvocations(db: Queryable, runId: string): Promise<Invocation[]> {
  const r = await db.query<Row>(
    `SELECT ${columns} FROM invocations WHERE run_id = $1 ORDER BY seq`,
    [runId],
  );
  return r.rows.map(toInvocation);
}

export async function markInvocationStarted(
  db: Queryable,
  id: string,
  podName: string,
): Promise<void> {
  await db.query(
    `UPDATE invocations SET status = 'running', pod_name = NULLIF($2, ''), started_at = COALESCE(started_at, now())
     WHERE id = $1 AND status IN ('pending', 'running')`,
    [id, podName],
  );
}

export async function markInvocationFinished(
  db: Queryable,
  id: string,
  input: { exitCode: number; sessionId: string | null; result: unknown },
): Promise<void> {
  await db.query(
    `UPDATE invocations SET status = $2, exit_code = $3, claude_session_id = $4, result_json = $5,
       finished_at = now()
     WHERE id = $1 AND status IN ('pending', 'running')`,
    [
      id,
      input.exitCode === 0 ? 'succeeded' : 'failed',
      input.exitCode,
      input.sessionId,
      JSON.stringify(input.result),
    ],
  );
}

export async function markInvocationStatus(
  db: Queryable,
  id: string,
  status: Exclude<InvocationStatus, 'pending' | 'running'>,
): Promise<void> {
  await db.query(
    `UPDATE invocations SET status = $2, finished_at = COALESCE(finished_at, now())
     WHERE id = $1 AND status IN ('pending', 'running')`,
    [id, status],
  );
}
