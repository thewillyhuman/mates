import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunEvent } from '@mates/core';
import { mintInvocationToken } from '../src/auth/invocation-token.js';
import { createInvocation } from '../src/runs/invocations.js';
import { stopTestDatabase } from './db.js';
import { INTERNAL_KEY, testApp, type TestApp } from './harness.js';

type Detail = {
  id: string;
  ticket: { key: string };
  projection: { stage: string; iteration: number };
};

describe('runs API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  it('requires an operator to trigger a run and a viewer to read', async () => {
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/runs', payload: { ticket_key: 'API-1' } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/runs',
          payload: { ticket_key: 'API-1' },
          headers: t.as('viewer'),
        })
      ).statusCode,
    ).toBe(403);
    expect((await t.app.inject({ url: '/api/runs' })).statusCode).toBe(401);
  });

  it('creates a queued run with a run.created event, idempotently per ticket', async () => {
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: 'API-198' },
      headers: t.as('operator'),
    });
    expect(first.statusCode).toBe(201);
    const detail = first.json<Detail>();
    expect(detail.ticket.key).toBe('API-198');
    expect(detail.projection.stage).toBe('queued');

    const again = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: 'API-198' },
      headers: t.as('operator'),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<Detail>().id).toBe(detail.id);

    const events = await t.app.inject({
      url: `/api/runs/${detail.id}/events`,
      headers: t.as('viewer'),
    });
    expect(events.json<{ events: RunEvent[] }>().events.map((e) => e.type)).toEqual([
      'run.created',
    ]);

    const board = await t.app.inject({ url: '/api/runs', headers: t.as('viewer') });
    expect(
      board.json<{ runs: { id: string; stage: string; currentAction: string }[] }>().runs,
    ).toMatchObject([{ id: detail.id, stage: 'queued', currentAction: 'In queue' }]);
  });

  it('rejects a malformed ticket key and unknown runs', async () => {
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: 'not a key' },
      headers: t.as('operator'),
    });
    expect(bad.statusCode).toBe(400);
    const missing = await t.app.inject({
      url: '/api/runs/00000000-0000-0000-0000-000000000000',
      headers: t.as('viewer'),
    });
    expect(missing.statusCode).toBe(404);
  });

  describe('runner event ingest', () => {
    let runId: string;
    let invocationId: string;
    let token: string;

    beforeAll(async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { ticket_key: 'API-200' },
        headers: t.as('operator'),
      });
      runId = res.json<Detail>().id;
      const inv = await createInvocation(t.db.pool, t.bus, {
        runId,
        mate: 'intake',
        iteration: 0,
        model: 'm',
      });
      invocationId = inv.id;
      expect(inv.jobName).toMatch(/^mates-r[0-9a-f]{8}-i1-intake$/);
      token = await mintInvocationToken(INTERNAL_KEY, { invocationId, runId }, 600);
    });

    const post = (body: Record<string, unknown>[], auth = `Bearer ${token}`, id = invocationId) =>
      t.app.inject({
        method: 'POST',
        url: `/internal/invocations/${id}/events`,
        payload: body,
        headers: { authorization: auth },
      });

    it('rejects missing, invalid and mismatched tokens', async () => {
      expect((await post([{ type: 'invocation.started', payload: {} }], '')).statusCode).toBe(401);
      expect(
        (await post([{ type: 'invocation.started', payload: {} }], 'Bearer nope')).statusCode,
      ).toBe(401);
      const other = await mintInvocationToken(
        INTERNAL_KEY,
        { invocationId: '00000000-0000-0000-0000-000000000000', runId },
        60,
      );
      expect(
        (await post([{ type: 'invocation.started', payload: {} }], `Bearer ${other}`)).statusCode,
      ).toBe(403);
    });

    it('accepts runner events, updates the invocation and the projection', async () => {
      const res = await post([
        { type: 'invocation.started', payload: { pod_name: 'pod-1' } },
        { type: 'invocation.tool_use', payload: { tool: 'Read', summary: 'read README.md' } },
      ]);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ accepted: 2, dropped: 0 });
      const detail = await t.app.inject({ url: `/api/runs/${runId}`, headers: t.as('viewer') });
      const p = detail.json<{
        projection: { currentInvocation: { status: string; podName: string; lastLine: string } };
      }>().projection;
      expect(p.currentInvocation).toMatchObject({
        status: 'running',
        podName: 'pod-1',
        lastLine: 'read README.md',
      });
      const row = await t.db.pool.query<{ status: string; pod_name: string }>(
        'SELECT status, pod_name FROM invocations WHERE id = $1',
        [invocationId],
      );
      expect(row.rows[0]).toEqual({ status: 'running', pod_name: 'pod-1' });
    });

    it('rejects orchestrator-only and malformed events', async () => {
      const notAllowed = await post([
        { type: 'run.stage_changed', payload: { from: 'queued', to: 'done', reason: 'x' } },
      ]);
      expect(notAllowed.statusCode).toBe(400);
      expect(notAllowed.json<{ error: { code: string } }>().error.code).toBe('event_not_allowed');
      const malformed = await post([{ type: 'implementation.pushed', payload: { commit: 1 } }]);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json<{ error: { code: string } }>().error.code).toBe('invalid_event');
    });

    it('paginates the event log with a cursor', async () => {
      const page1 = await t.app.inject({
        url: `/api/runs/${runId}/events?limit=2`,
        headers: t.as('viewer'),
      });
      const body1 = page1.json<{ events: RunEvent[]; next_after: number | null }>();
      expect(body1.events).toHaveLength(2);
      expect(body1.next_after).toBe(body1.events[1]!.id);
      const page2 = await t.app.inject({
        url: `/api/runs/${runId}/events?limit=2&after=${body1.next_after}`,
        headers: t.as('viewer'),
      });
      const body2 = page2.json<{ events: RunEvent[]; next_after: number | null }>();
      expect(body2.events[0]!.id).toBeGreaterThan(body1.next_after!);
      expect(body2.next_after).toBeNull();
    });

    it('marks the invocation finished from invocation.finished', async () => {
      const res = await post([
        {
          type: 'invocation.finished',
          payload: {
            exit_code: 0,
            duration_ms: 1234,
            session_id: 'sess',
            result: { total_cost_usd: 0.1 },
          },
        },
      ]);
      expect(res.statusCode).toBe(202);
      const row = await t.db.pool.query<{
        status: string;
        claude_session_id: string;
        result_json: { total_cost_usd: number };
      }>('SELECT status, claude_session_id, result_json FROM invocations WHERE id = $1', [
        invocationId,
      ]);
      expect(row.rows[0]).toMatchObject({
        status: 'succeeded',
        claude_session_id: 'sess',
        result_json: { total_cost_usd: 0.1 },
      });
    });
  });
});
