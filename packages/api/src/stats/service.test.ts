import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase, stopTestDatabase, type TestDatabase } from '../../test/db.js';
import { StatsService } from './service.js';

afterAll(stopTestDatabase);

/** Seeds a ticket, a run, one invocation per mate and usage rows, all with the given timestamps. */
async function seedRun(
  db: TestDatabase,
  opts: {
    key: string;
    status: string;
    iteration: number;
    createdAt: string;
    finishedAt: string | null;
    repo?: string;
    usage: { mate: string; model: string; usd: number; computed: number | null; tokens: number }[];
    mrState?: string;
  },
): Promise<string> {
  const t = await db.pool.query<{ id: string }>(
    `INSERT INTO tickets (external_key, title, project_key, repo_id) VALUES ($1, $1, split_part($1, '-', 1), $2) RETURNING id`,
    [opts.key, opts.repo ?? null],
  );
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO runs (ticket_id, status, iteration, max_iterations, created_by, created_at, finished_at, mr_state)
     VALUES ($1, $2, $3, 4, 'test', $4, $5, $6) RETURNING id`,
    [
      t.rows[0]!.id,
      opts.status,
      opts.iteration,
      opts.createdAt,
      opts.finishedAt,
      opts.mrState ?? null,
    ],
  );
  const runId = r.rows[0]!.id;
  let seq = 0;
  for (const u of opts.usage) {
    seq += 1;
    const inv = await db.pool.query<{ id: string }>(
      `INSERT INTO invocations (run_id, seq, mate, iteration, status, k8s_job_name, model) VALUES ($1, $2, $3, 1, 'succeeded', $4, $5) RETURNING id`,
      [runId, seq, u.mate, `job-${seq}`, u.model],
    );
    await db.pool.query(
      `INSERT INTO usage (invocation_id, run_id, model, input_tokens, output_tokens, cost_usd_reported, cost_usd_computed, ts)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7)`,
      [inv.rows[0]!.id, runId, u.model, u.tokens, u.usd, u.computed, opts.createdAt],
    );
  }
  await db.pool.query(
    `INSERT INTO events (run_id, ts, type, payload) VALUES ($1, $2, 'run.created', '{}')`,
    [runId, opts.createdAt],
  );
  return runId;
}

describe('StatsService', () => {
  let db: TestDatabase;
  let stats: StatsService;
  beforeAll(async () => {
    db = await freshDatabase();
    stats = new StatsService(db.pool);
    await seedRun(db, {
      key: 'API-1',
      status: 'done',
      iteration: 2,
      createdAt: '2026-10-01T10:00:00Z',
      finishedAt: '2026-10-01T11:00:00Z',
      repo: 'webhook',
      usage: [
        { mate: 'implementer', model: 'opus', usd: 3, computed: 3.3, tokens: 1000 },
        { mate: 'reviewer', model: 'opus', usd: 1, computed: 1, tokens: 500 },
      ],
    });
    await seedRun(db, {
      key: 'API-2',
      status: 'done',
      iteration: 1,
      createdAt: '2026-10-02T10:00:00Z',
      finishedAt: '2026-10-02T10:30:00Z',
      repo: 'webhook',
      usage: [{ mate: 'implementer', model: 'opus', usd: 2, computed: null, tokens: 800 }],
    });
    await seedRun(db, {
      key: 'BILL-3',
      status: 'failed',
      iteration: 1,
      createdAt: '2026-10-02T12:00:00Z',
      finishedAt: '2026-10-02T12:10:00Z',
      repo: 'billing',
      usage: [{ mate: 'intake', model: 'sonnet', usd: 0.5, computed: 0.5, tokens: 100 }],
    });
  });

  it('rolls usage up by day, mate, model, repo and project', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-03T00:00:00Z');
    expect(await stats.usage(from, to, 'day')).toEqual([
      expect.objectContaining({
        key: '2026-10-01',
        cost_usd: 4,
        cost_usd_computed: 4.3,
        input_tokens: 1500,
        invocations: 2,
      }),
      expect.objectContaining({
        key: '2026-10-02',
        cost_usd: 2.5,
        cost_usd_computed: null,
        input_tokens: 900,
        invocations: 2,
      }),
    ]);
    const byMate = await stats.usage(from, to, 'mate');
    expect(byMate.map((b) => [b.key, b.cost_usd])).toEqual([
      ['implementer', 5],
      ['intake', 0.5],
      ['reviewer', 1],
    ]);
    expect((await stats.usage(from, to, 'model')).map((b) => b.key)).toEqual(['opus', 'sonnet']);
    expect((await stats.usage(from, to, 'repo')).map((b) => [b.key, b.cost_usd])).toEqual([
      ['billing', 0.5],
      ['webhook', 6],
    ]);
    expect((await stats.usage(from, to, 'project')).map((b) => [b.key, b.cost_usd])).toEqual([
      ['API', 6],
      ['BILL', 0.5],
    ]);
    expect(await stats.usage(new Date('2027-01-01'), new Date('2027-02-01'), 'day')).toEqual([]);
  });

  it('reports outcomes: cost per done MR, iterations histogram, durations', async () => {
    const o = await stats.outcomes(
      new Date('2026-10-01T00:00:00Z'),
      new Date('2026-10-03T00:00:00Z'),
    );
    expect(o).toMatchObject({ runs_done: 2, runs_failed: 1, runs_blocked: 0, cost_per_done_mr: 3 });
    expect(o.iterations_to_approval).toEqual([
      { iterations: 1, count: 1 },
      { iterations: 2, count: 1 },
    ]);
    expect(o.duration_p50_ms).toBe(30 * 60 * 1000);
    // Durations 10, 30 and 60 minutes: p90 interpolates between 30 and 60.
    expect(o.duration_p90_ms).toBe(54 * 60 * 1000);
  });

  it('builds the board strip with a daily budget banner', async () => {
    await seedRun(db, {
      key: 'API-9',
      status: 'implementing',
      iteration: 1,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      usage: [{ mate: 'implementer', model: 'opus', usd: 7, computed: null, tokens: 400 }],
      mrState: 'draft',
    });
    const run = await seedRun(db, {
      key: 'API-10',
      status: 'blocked',
      iteration: 4,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      usage: [],
    });
    await db.pool.query(
      `INSERT INTO events (run_id, type, payload) VALUES ($1, 'run.stage_changed', '{"from":"reviewing","to":"blocked","reason":"iteration_cap"}')`,
      [run],
    );
    const b = await stats.board('UTC', 5, 4);
    expect(b.running).toEqual({ total: 1, by_stage: { implementing: 1 } });
    expect(b.waiting).toEqual({ total: 1, by_reason: { iteration_cap: 1 } });
    expect(b.spend_today).toEqual({ tokens: 400, usd: 7, per_ticket_tokens: 400, runs: 1 });
    expect(b.daily_budget).toMatchObject({ limit: 5, spent: 7, exceeded: true });
    expect(new Date(b.daily_budget.resets_at).getTime()).toBeGreaterThan(Date.now());
    expect(b.iterations_to_approval_7d.cap).toBe(4);
  });
});
