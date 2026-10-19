import { describe, expect, it, vi } from 'vitest';
import { RunnerApi } from './api.js';
import type { Log } from './log.js';

const log: Log = { info: () => undefined, warn: () => undefined, error: () => undefined };

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: u, init: init ?? {} });
    return handler(u, init ?? {});
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const base = {
  apiUrl: 'http://api',
  token: 'tok',
  invocationId: 'inv-1',
  secrets: ['s3cr3t-value'],
  log,
};

describe('RunnerApi', () => {
  it('batches events, redacts payloads and sends the bearer token', async () => {
    const f = fakeFetch(
      () => new Response(JSON.stringify({ accepted: 1, dropped: 0 }), { status: 202 }),
    );
    const api = new RunnerApi({ ...base, fetch: f.fn, flushIntervalMs: 20 });
    api.emit({ type: 'invocation.text', payload: { text: 'token is s3cr3t-value' } });
    api.emit({ type: 'invocation.heartbeat', payload: {} });
    await new Promise((r) => setTimeout(r, 60));
    await api.flush();
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe('http://api/internal/invocations/inv-1/events');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const body = JSON.parse(call.init.body as string) as {
      type: string;
      payload: { text?: string };
    }[];
    expect(body.map((e) => e.type)).toEqual(['invocation.text', 'invocation.heartbeat']);
    expect(body[0]!.payload.text).toBe('token is [redacted]');
  });

  it('flushes immediately at 50 events', async () => {
    const f = fakeFetch(() => new Response('{}', { status: 202 }));
    const api = new RunnerApi({ ...base, fetch: f.fn, flushIntervalMs: 10_000 });
    for (let i = 0; i < 50; i++) api.emit({ type: 'invocation.heartbeat', payload: {} });
    await api.flush();
    expect(f.calls).toHaveLength(1);
  });

  it('retries 5xx and gives up on 4xx', async () => {
    let n = 0;
    const flaky = fakeFetch(() => new Response('oops', { status: n++ === 0 ? 503 : 202 }));
    const api = new RunnerApi({ ...base, fetch: flaky.fn });
    api.emit({ type: 'invocation.heartbeat', payload: {} });
    await api.flush();
    expect(flaky.calls).toHaveLength(2);

    const bad = fakeFetch(
      () => new Response('{"error":{"code":"invalid_event"}}', { status: 400 }),
    );
    const api2 = new RunnerApi({ ...base, fetch: bad.fn });
    api2.emit({ type: 'invocation.heartbeat', payload: {} });
    await expect(api2.flush()).rejects.toThrow(/HTTP 400/);
    expect(bad.calls).toHaveLength(1);
  });

  it('uploads blobs and returns the id', async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ id: 'blob-9' }), { status: 201 }));
    const api = new RunnerApi({ ...base, fetch: f.fn });
    expect(await api.uploadBlob('tests_log', 'Ran 3 tests', 'text/plain')).toBe('blob-9');
    expect(f.calls[0]!.url).toBe('http://api/internal/invocations/inv-1/blobs/tests_log');
    expect((f.calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('text/plain');
  });
});
