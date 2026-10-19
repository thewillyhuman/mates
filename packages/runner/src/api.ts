import { redactValue, type NewEvent } from '@mates/core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Log } from './log.js';

const execFileAsync = promisify(execFile);

/**
 * Client for the runner-only endpoints (§5.1 item 4, §7.3). Events are
 * buffered and flushed every second or every 50 events; every payload goes
 * through redaction first. Blob uploads and the context download are
 * direct calls with a timeout and bounded retries.
 */
export interface RunnerApiOptions {
  apiUrl: string;
  token: string;
  invocationId: string;
  secrets: readonly string[];
  log: Log;
  fetch?: typeof fetch;
  /** Flush interval in ms (tests shorten it). */
  flushIntervalMs?: number;
}

const BATCH_MAX = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRIES = 4;

export class RunnerApi {
  private readonly queue: NewEvent[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: RunnerApiOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** Queues an event; the payload is redacted here, once. */
  emit(event: NewEvent): void {
    this.queue.push(redactValue(event, { secrets: this.opts.secrets }));
    if (this.queue.length >= BATCH_MAX) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.opts.flushIntervalMs ?? 1000);
    }
  }

  /** Sends everything queued. Serialised so batches stay in order. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flushing = this.flushing.then(async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, BATCH_MAX);
        await this.request('POST', `/internal/invocations/${this.opts.invocationId}/events`, {
          body: JSON.stringify(batch),
          contentType: 'application/json',
        });
      }
    });
    return this.flushing;
  }

  async uploadBlob(kind: string, data: Buffer | string, contentType: string): Promise<string> {
    const res = await this.request(
      'POST',
      `/internal/invocations/${this.opts.invocationId}/blobs/${kind}`,
      {
        body: data,
        contentType,
      },
    );
    const json = (await res.json()) as { id: string };
    return json.id;
  }

  /** Downloads the context tar.gz and extracts it into `dir`. */
  async downloadContext(dir: string): Promise<void> {
    const res = await this.request(
      'GET',
      `/internal/invocations/${this.opts.invocationId}/context`,
    );
    await mkdir(dir, { recursive: true });
    const archive = path.join(dir, '.context.tar.gz');
    await writeFile(archive, Buffer.from(await res.arrayBuffer()));
    // Never restore ownership, modes or mtimes: /context is an emptyDir we do not own.
    await execFileAsync('tar', [
      '-xzf',
      archive,
      '-C',
      dir,
      '--no-same-owner',
      '--no-same-permissions',
      '-m',
    ]);
  }

  private async request(
    method: 'GET' | 'POST',
    route: string,
    init: { body?: Buffer | string; contentType?: string } = {},
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}` };
        if (init.contentType) headers['content-type'] = init.contentType;
        const request: RequestInit = {
          method,
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        };
        if (init.body !== undefined) request.body = init.body;
        const res = await this.fetchFn(`${this.opts.apiUrl}${route}`, request);
        if (res.ok) return res;
        const text = await res.text().catch(() => '');
        // 4xx other than 429 will not get better by retrying.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`${method} ${route}: HTTP ${res.status} ${text.slice(0, 300)}`);
        }
        lastError = new Error(`${method} ${route}: HTTP ${res.status}`);
      } catch (err) {
        if (err instanceof Error && /HTTP 4\d\d/.test(err.message)) throw err;
        lastError = err;
      }
      this.opts.log.warn('api request failed, retrying', {
        route,
        attempt,
        error: String(lastError),
      });
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
    throw new Error(
      `${method} ${route}: giving up after ${RETRIES} attempts: ${String(lastError)}`,
    );
  }
}
