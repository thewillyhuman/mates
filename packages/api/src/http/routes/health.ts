import type { FastifyInstance } from 'fastify';
import type { Pool } from '../../db/pool.js';
import { pendingMigrations } from '../../db/migrate.js';

/**
 * `/healthz`: the process is up. `/readyz`: it can serve traffic — database
 * reachable, migrations applied and, in-cluster, the Kubernetes API answers
 * (§14).
 */
export interface ReadinessDeps {
  db: Pool;
  kubernetes?: { ping(): Promise<void> } | undefined;
}

type Check = { ok: true; skipped?: true } | { ok: false; error: string };

async function check(fn: () => Promise<void>): Promise<Check> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function healthRoutes(app: FastifyInstance, deps: ReadinessDeps): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const k8s = deps.kubernetes;
    const checks: Record<string, Check> = {
      database: await check(async () => {
        await deps.db.query('SELECT 1');
      }),
      migrations: await check(async () => {
        const pending = await pendingMigrations(deps.db);
        if (pending.length) throw new Error(`pending: ${pending.join(', ')}`);
      }),
      kubernetes: k8s ? await check(() => k8s.ping()) : { ok: true, skipped: true },
    };
    const ready = Object.values(checks).every((c) => c.ok);
    return reply.status(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks });
  });
}
