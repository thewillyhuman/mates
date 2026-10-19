import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopTestDatabase } from './db.js';
import { testApp, type TestApp } from './harness.js';
import { configureLoop, loopDriver } from './loop-driver.js';

describe('cost ledger and stats', () => {
  let t: TestApp;
  let runId: string;
  beforeAll(async () => {
    t = await testApp();
    await configureLoop(t);
    // Price the implementer/reviewer model so computed costs exist; leave the intake model unpriced.
    await t.app.inject({
      method: 'PUT',
      url: '/api/settings/pricing',
      payload: {
        'claude-opus-5-5': {
          input_per_mtok: 15,
          output_per_mtok: 75,
          cache_read_per_mtok: 1.5,
          cache_write_per_mtok: 18.75,
        },
      },
      headers: t.as('admin'),
    });
    const { trigger, play, reconcile } = loopDriver(t);
    const run = await trigger('API-501', 'Ledger');
    runId = run.id;
    await reconcile(run.id);
    await play(run.id, 'intake_implementable');
    await play(run.id, 'impl_iter1_green');
    await play(run.id, 'review_approve');
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  it('writes one ledger row per invocation with reported and computed cost', async () => {
    const rows = await t.db.pool.query<{
      model: string;
      cost_usd_reported: string;
      cost_usd_computed: string | null;
      input_tokens: string;
    }>(
      'SELECT model, cost_usd_reported, cost_usd_computed, input_tokens FROM usage WHERE run_id = $1 ORDER BY ts',
      [runId],
    );
    expect(rows.rows.map((r) => r.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-opus-5-5',
    ]);
    expect(Number(rows.rows[0]!.cost_usd_reported)).toBeCloseTo(0.0412, 4);
    expect(rows.rows[0]!.cost_usd_computed).toBeNull();
    expect(rows.rows[1]!.cost_usd_computed).not.toBeNull();
    expect(Number(rows.rows[1]!.input_tokens)).toBeGreaterThan(0);
  });

  it('serves rollups, outcomes and the board strip', async () => {
    const usage = await t.app.inject({ url: '/api/stats?group_by=mate', headers: t.as('viewer') });
    expect(usage.statusCode).toBe(200);
    const body = usage.json<{
      buckets: { key: string; cost_usd: number; cost_usd_computed: number | null }[];
      note: string;
    }>();
    expect(body.buckets.map((b) => b.key)).toEqual(['implementer', 'intake', 'reviewer']);
    expect(body.buckets.find((b) => b.key === 'intake')!.cost_usd_computed).toBeNull();
    expect(body.buckets.find((b) => b.key === 'reviewer')!.cost_usd_computed).not.toBeNull();
    expect(body.note).toContain('estimate');
    expect(
      (await t.app.inject({ url: '/api/stats?group_by=nope', headers: t.as('viewer') })).statusCode,
    ).toBe(400);

    const outcomes = await t.app.inject({ url: '/api/stats/outcomes', headers: t.as('viewer') });
    expect(outcomes.json()).toMatchObject({
      runs_done: 1,
      iterations_to_approval: [{ iterations: 1, count: 1 }],
    });
    expect(outcomes.json<{ cost_per_done_mr: number }>().cost_per_done_mr).toBeCloseTo(
      0.0412 + 1.8734 + 0.8117,
      3,
    );

    const board = await t.app.inject({ url: '/api/stats/board', headers: t.as('viewer') });
    expect(board.json()).toMatchObject({
      running: { total: 0 },
      mrs_opened_today: { total: 1, ready: 1, draft: 0 },
      iterations_to_approval_7d: { average: 1, cap: 4 },
      daily_budget: { limit: 1000, exceeded: false },
    });
    expect(
      board.json<{ spend_today: { usd: number; tokens: number; runs: number } }>().spend_today,
    ).toMatchObject({ runs: 1 });
    expect((await t.app.inject({ url: '/api/stats/board' })).statusCode).toBe(401);
  });

  it('exposes and replaces the pricing table', async () => {
    const get = await t.app.inject({ url: '/api/settings/pricing', headers: t.as('viewer') });
    expect(get.json()).toMatchObject({
      pricing: { 'claude-opus-5-5': { input_per_mtok: 15 } },
      hint: expect.stringContaining('anthropic.com/pricing') as string,
    });
    const put = await t.app.inject({
      method: 'PUT',
      url: '/api/settings/pricing',
      payload: {
        'claude-haiku-5-5': {
          input_per_mtok: 1,
          output_per_mtok: 5,
          cache_read_per_mtok: 0.1,
          cache_write_per_mtok: 1.25,
        },
      },
      headers: t.as('admin'),
    });
    expect(put.statusCode).toBe(200);
    expect(Object.keys(put.json<{ pricing: Record<string, unknown> }>().pricing)).toEqual([
      'claude-haiku-5-5',
    ]);
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/api/settings/pricing',
          payload: { x: { input_per_mtok: -1 } },
          headers: t.as('admin'),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await t.app.inject({
          method: 'PUT',
          url: '/api/settings/pricing',
          payload: {},
          headers: t.as('operator'),
        })
      ).statusCode,
    ).toBe(403);
  });
});
