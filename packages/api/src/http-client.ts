/**
 * Minimal JSON HTTP client for the adapters: one timeout, bounded retries
 * on 5xx/429/network errors, errors that carry the status and a trimmed
 * body. `fetch` is injectable so tests replay recorded fixtures.
 */
export interface HttpClientOptions {
  baseUrl: string;
  headers: Record<string, string>;
  /** Resolved on every request, for short-lived tokens that renew themselves. */
  authorization?: (() => Promise<string>) | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number;
  retries?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: string,
  ) {
    super(`${method} ${url} → HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
}

export class HttpClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/+$/, '');
  }

  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const res = await this.request(method, path, body, extraHeaders);
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(res.status, method, path, `non-JSON response: ${text.slice(0, 120)}`);
    }
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const retries = this.opts.retries ?? 2;
    const dynamic = this.opts.authorization
      ? { authorization: await this.opts.authorization() }
      : {};
    let last: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const init: RequestInit = {
          method,
          headers: {
            accept: 'application/json',
            ...this.opts.headers,
            ...dynamic,
            ...extraHeaders,
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
        };
        if (body !== undefined) {
          init.body = JSON.stringify(body);
          init.headers = {
            ...(init.headers as Record<string, string>),
            'content-type': 'application/json',
          };
        }
        const res = await this.fetchFn(url, init);
        if (res.ok) return res;
        const text = await res.text().catch(() => '');
        const err = new HttpError(res.status, method, url, text);
        if (res.status >= 500 || res.status === 429) {
          last = err;
        } else {
          throw err;
        }
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
        last = err;
      }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}
