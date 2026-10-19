import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopTestDatabase } from './db.js';
import { testApp, type TestApp } from './harness.js';

/** Reads SSE frames from a fetch body until `count` events arrive or it times out. */
async function readEvents(
  res: Response,
  count: number,
  timeoutMs = 5000,
): Promise<{ event: string; id?: string; data: unknown }[]> {
  const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  const out: { event: string; id?: string; data: unknown }[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (out.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((r) =>
        setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now()),
      ),
    ]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = frame.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
      const id = lines.find((l) => l.startsWith('id: '))?.slice(4);
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
      if (event && data)
        out.push({ event, data: JSON.parse(data), ...(id !== undefined ? { id } : {}) });
    }
  }
  await reader.cancel().catch(() => undefined);
  return out;
}

describe('SSE streams', () => {
  let t: TestApp;
  let base: string;
  beforeAll(async () => {
    t = await testApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = t.app.server.address();
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

  it('replays the backlog after the cursor and then streams live events', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: 'SSE-1' },
      headers: t.as('operator'),
    });
    const runId = created.json<{ id: string }>().id;

    const res = await fetch(`${base}/api/runs/${runId}/stream`, {
      headers: { cookie: t.as('viewer').cookie! },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // Publish a live event while the stream is open.
    setTimeout(() => {
      void import('../src/runs/events.js').then(({ appendEvents }) =>
        appendEvents(t.db.pool, t.bus, runId, [{ type: 'run.paused', payload: { by: 'ana' } }]),
      );
    }, 100);

    const events = await readEvents(res, 2);
    expect(events.map((e) => e.event)).toEqual(['run.created', 'run.paused']);
    expect(Number(events[1]!.id)).toBeGreaterThan(Number(events[0]!.id));

    // Reconnecting after the last id yields nothing old.
    const again = await fetch(`${base}/api/runs/${runId}/stream?after=${events[1]!.id}`, {
      headers: { cookie: t.as('viewer').cookie! },
    });
    const none = await readEvents(again, 1, 400);
    expect(none).toEqual([]);
  });

  it('sends board summaries on the global stream', async () => {
    const res = await fetch(`${base}/api/stream`, { headers: { cookie: t.as('viewer').cookie! } });
    expect(res.status).toBe(200);
    setTimeout(() => {
      void t.app.inject({
        method: 'POST',
        url: '/api/runs',
        payload: { ticket_key: 'SSE-2' },
        headers: t.as('operator'),
      });
    }, 100);
    const [summary] = await readEvents(res, 1);
    expect(summary?.event).toBe('run');
    expect(summary?.data).toMatchObject({ stage: 'queued', ticket: { key: 'SSE-2' } });
  });

  it('refuses anonymous clients', async () => {
    const res = await fetch(`${base}/api/stream`);
    expect(res.status).toBe(401);
  });
});
