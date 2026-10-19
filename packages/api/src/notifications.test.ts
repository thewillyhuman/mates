import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@mates/core';
import { freshDatabase, stopTestDatabase, type TestDatabase } from '../test/db.js';
import { createLogger } from './logger.js';
import { Notifier } from './notifications.js';
import { EventBus } from './runs/bus.js';
import { createRun } from './runs/repository.js';
import { SettingsService } from './settings/service.js';

afterAll(stopTestDatabase);

describe('Notifier', () => {
  let db: TestDatabase;
  let runId: string;
  beforeAll(async () => {
    db = await freshDatabase();
    const r = await createRun(db.pool, new EventBus(), {
      ticket: { externalKey: 'API-9' },
      trigger: 'manual',
      by: 't',
      maxIterations: 4,
      budgetUsd: null,
    });
    runId = r.run.id;
  });

  it('describes the five announced events and ignores the rest', async () => {
    const n = new Notifier({
      db: db.pool,
      bus: new EventBus(),
      settings: new SettingsService(db.pool),
      log: createLogger('silent'),
      publicUrl: 'https://m',
    });
    const ev = (type: RunEvent['type'], payload: unknown): RunEvent =>
      ({ id: 1, run_id: runId, invocation_id: null, ts: '', type, payload }) as RunEvent;
    expect(
      await n.describe(
        ev('intake.needs_clarification', { questions: ['Which tier?'], tracker_comment_id: null }),
      ),
    ).toMatchObject({
      text: 'API-9: Mates needs clarification — Which tier?',
      url: `https://m/runs/${runId}`,
    });
    expect(
      await n.describe(
        ev('run.stage_changed', { from: 'reviewing', to: 'blocked', reason: 'iteration_cap' }),
      ),
    ).toMatchObject({ text: 'API-9: run blocked (iteration cap)' });
    expect(
      await n.describe(ev('run.stage_changed', { from: 'queued', to: 'intake', reason: 'x' })),
    ).toBeNull();
    expect(await n.describe(ev('mr.marked_ready', { mr_id: '12' }))).toMatchObject({
      text: 'API-9: merge request 12 is ready for human review',
    });
    expect(await n.describe(ev('run.failed', { reason: 'empty_diff', detail: '' }))).toMatchObject({
      text: 'API-9: run failed — empty_diff',
    });
    expect(
      await n.describe(ev('run.budget_exceeded', { kind: 'usd', limit: 25, used: 26.1 })),
    ).toMatchObject({ text: 'API-9: budget exceeded ($26.10 of $25.00)' });
    expect(await n.describe(ev('invocation.heartbeat', {}))).toBeNull();
  });

  it('posts Slack-compatible JSON and retries once', async () => {
    const calls: { url: string; body: unknown }[] = [];
    let first = true;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        body: JSON.parse(init!.body as string),
      });
      if (first) {
        first = false;
        return new Response('', { status: 503 });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const n = new Notifier({
      db: db.pool,
      bus: new EventBus(),
      settings: new SettingsService(db.pool),
      log: createLogger('silent'),
      publicUrl: 'https://m',
      fetch: fetchFn,
    });
    const ok = await n.send('https://hooks.example/abc', {
      event: 'run.failed',
      text: 'API-9: run failed — x',
      run_id: runId,
      ticket: 'API-9',
      url: 'https://m/runs/1',
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({
      text: 'API-9: run failed — x — https://m/runs/1',
      blocks: [{ type: 'section' }],
      mates: { event: 'run.failed', ticket: 'API-9' },
    });
  });
});
