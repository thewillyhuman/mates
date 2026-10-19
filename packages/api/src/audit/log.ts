import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Pool, Queryable } from '../db/pool.js';

/**
 * Audit log (§10.4, decision 0018): one row per mutating action with the
 * actor, an `audit.<area>.<verb>` action name, the target and small
 * details. Routes call `request.audit(...)`; secrets are never recorded.
 */
export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
}

export async function recordAudit(
  db: Queryable,
  entry: { actor: string; action: string; target?: string; details?: Record<string, unknown> },
): Promise<void> {
  await db.query('INSERT INTO audit_log (actor, action, target, details) VALUES ($1, $2, $3, $4)', [
    entry.actor,
    entry.action,
    entry.target ?? '',
    JSON.stringify(entry.details ?? {}),
  ]);
}

export async function listAudit(
  db: Queryable,
  opts: { before?: number | undefined; limit?: number | undefined } = {},
): Promise<AuditEntry[]> {
  const r = await db.query<{
    id: string;
    ts: Date;
    actor: string;
    action: string;
    target: string;
    details: Record<string, unknown>;
  }>(
    `SELECT id, ts, actor, action, target, details FROM audit_log WHERE id < $1 ORDER BY id DESC LIMIT $2`,
    [opts.before ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 100],
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    ts: x.ts.toISOString(),
    actor: x.actor,
    action: x.action,
    target: x.target,
    details: x.details,
  }));
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Records an audit row for the current user (or the given actor). */
    audit(action: string, target?: string, details?: Record<string, unknown>): Promise<void>;
  }
}

export const auditPlugin = fp<{ db: Pool }>(async (app: FastifyInstance, opts) => {
  app.decorateRequest(
    'audit',
    function (
      this: FastifyRequest,
      action: string,
      target = '',
      details: Record<string, unknown> = {},
    ) {
      return recordAudit(opts.db, {
        actor: this.user?.email ?? 'anonymous',
        action,
        target,
        details,
      });
    },
  );
});
