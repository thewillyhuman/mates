import type { Pool, Queryable } from '../db/pool.js';
import type { EventBus } from './bus.js';
import { appendEvents } from './events.js';

/** Human notes for the implementer's next iteration (§7.5 rule 9). */
export interface Nudge {
  id: string;
  runId: string;
  author: string;
  text: string;
  postToTracker: boolean;
  createdAt: Date;
  consumedByInvocationId: string | null;
}

export async function createNudge(
  pool: Pool,
  bus: EventBus,
  input: { runId: string; author: string; text: string; postToTracker: boolean },
): Promise<Nudge> {
  const r = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO nudges (run_id, author, text, post_to_tracker) VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [input.runId, input.author, input.text, input.postToTracker],
  );
  const row = r.rows[0]!;
  await appendEvents(pool, bus, input.runId, [
    { type: 'nudge.added', payload: { nudge_id: row.id, by: input.author, text: input.text } },
  ]);
  return {
    id: row.id,
    runId: input.runId,
    author: input.author,
    text: input.text,
    postToTracker: input.postToTracker,
    createdAt: row.created_at,
    consumedByInvocationId: null,
  };
}

export async function markNudgesConsumed(
  db: Queryable,
  nudgeIds: string[],
  invocationId: string,
): Promise<void> {
  if (nudgeIds.length === 0) return;
  await db.query('UPDATE nudges SET consumed_by_invocation_id = $2 WHERE id = ANY($1::uuid[])', [
    nudgeIds,
    invocationId,
  ]);
}
