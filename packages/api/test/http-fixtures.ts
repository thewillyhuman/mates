import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Recorded HTTP exchanges for adapter tests (§15.1). A fixture file holds
 * an array of `{ request: { method, url, bodyIncludes? }, response: { status, body } }`;
 * `url` is matched as a suffix of the requested URL (path + query), so
 * fixtures do not depend on the base URL. Every call is logged.
 */
export interface Exchange {
  request: { method: string; url: string; bodyIncludes?: string };
  response: { status: number; body?: unknown; headers?: Record<string, string> };
}

export interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/http');

export function loadFixture(provider: string, name: string): Exchange[] {
  return JSON.parse(readFileSync(path.join(DIR, provider, `${name}.json`), 'utf8')) as Exchange[];
}

export function fixtureFetch(exchanges: Exchange[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (safeJson(init.body) ?? init.body) : undefined;
    calls.push({ method, url, body, headers: (init?.headers as Record<string, string>) ?? {} });
    const match = exchanges.find(
      (e) =>
        e.request.method.toUpperCase() === method &&
        url.endsWith(e.request.url) &&
        (e.request.bodyIncludes === undefined ||
          (typeof init?.body === 'string' && init.body.includes(e.request.bodyIncludes))),
    );
    if (!match) {
      return new Response(JSON.stringify({ error: `no fixture for ${method} ${url}` }), {
        status: 599,
      });
    }
    const text =
      match.response.body === undefined
        ? ''
        : typeof match.response.body === 'string'
          ? match.response.body
          : JSON.stringify(match.response.body);
    const status = match.response.status;
    // The Response constructor refuses a body for 204/205/304.
    const responseBody = status === 204 || status === 205 || status === 304 ? null : text;
    return new Response(responseBody, {
      status,
      headers: { 'content-type': 'application/json', ...match.response.headers },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
