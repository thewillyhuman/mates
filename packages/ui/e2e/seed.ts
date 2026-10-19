import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, type APIRequestContext } from '@playwright/test';
import { SignJWT } from 'jose';
import { INTERNAL_KEY, STATE_FILE } from './global-setup.js';

/**
 * Seeds the server through its own API: the first admin, settings, a team
 * context package, and runs driven with the fixtures' result lines through
 * the internal ingest endpoint (the same way the API's loop tests do).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../../../fixtures/claude');
const TEAM_PKG = path.resolve(here, 'team-context.tgz');

export const ADMIN = { email: 'admin@example.com', password: 'playwright-password' };

export function state(): { token: string; port: number } {
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { token: string; port: number };
}

export async function adminContext(baseURL: string): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL });
  const status = (await (await ctx.get('/api/setup/status')).json()) as { setupRequired: boolean };
  if (status.setupRequired) {
    const r = await ctx.post('/api/setup/bootstrap', { data: { token: state().token, ...ADMIN } });
    if (r.status() !== 201) throw new Error(`bootstrap failed: ${await r.text()}`);
  } else {
    const r = await ctx.post('/api/auth/login', { data: ADMIN });
    if (!r.ok()) throw new Error(`login failed: ${await r.text()}`);
  }
  const cookies = await ctx.storageState();
  const csrf = cookies.cookies.find((c) => c.name === 'mates_csrf')?.value ?? '';
  const authed = await request.newContext({
    baseURL,
    storageState: cookies,
    extraHTTPHeaders: { 'x-csrf-token': csrf },
  });
  await ctx.dispose();
  return authed;
}

export async function configure(ctx: APIRequestContext): Promise<void> {
  await ctx.put('/api/settings', {
    data: {
      scm: {
        providers: [
          { id: 'gitea', type: 'gitea', base_url: 'http://gitea.local:3000', username: 'mates' },
        ],
      },
      jira: {
        base_url: 'https://jira.example.com',
        trigger: { kind: 'assignee', value: 'mates' },
        status_map: { in_progress: 'In Progress', mr_ready: 'In Review', blocked: 'Needs Info' },
      },
      limits: { max_iterations: 4, per_run_usd: 25, per_day_usd: 1000 },
    },
  });
  const existing = (await (await ctx.get('/api/settings/team-context')).json()) as {
    active: unknown;
  };
  if (!existing.active) {
    const r = await ctx.post('/api/settings/team-context', {
      headers: { 'content-type': 'application/gzip' },
      data: readFileSync(TEAM_PKG),
    });
    if (r.status() !== 201) throw new Error(`team context upload failed: ${await r.text()}`);
  }
}

function fixtureResult(scenario: string): Record<string, unknown> {
  const lines = readFileSync(path.join(FIXTURES, `${scenario}.jsonl`), 'utf8')
    .trim()
    .split('\n');
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

async function mint(invocationId: string, runId: string): Promise<string> {
  return new SignJWT({ run_id: runId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(invocationId)
    .setAudience('mates-runner')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(new TextEncoder().encode(INTERNAL_KEY));
}

interface Detail {
  id: string;
  projection: { stage: string; currentInvocation: { id: string; mate: string } | null };
}

export async function trigger(ctx: APIRequestContext, key: string): Promise<Detail> {
  const r = await ctx.post('/api/runs', { data: { ticket_key: key } });
  if (r.status() !== 201 && r.status() !== 200)
    throw new Error(`trigger failed: ${await r.text()}`);
  return (await r.json()) as Detail;
}

/** Waits for the orchestrator (5 s loop + event-driven) to schedule an invocation. */
export async function waitForInvocation(
  ctx: APIRequestContext,
  runId: string,
  timeoutMs = 15_000,
): Promise<Detail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = (await (await ctx.get(`/api/runs/${runId}`)).json()) as Detail;
    if (d.projection.currentInvocation) return d;
    if (Date.now() > deadline)
      throw new Error(`no invocation scheduled for ${runId} (stage ${d.projection.stage})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Plays the runner for the current invocation with a fixture: started, tail lines, push/tests, finished. */
export async function play(
  ctx: APIRequestContext,
  runId: string,
  scenario: string,
  opts: { changed?: boolean; tail?: number } = {},
): Promise<Detail> {
  const d = await waitForInvocation(ctx, runId);
  const inv = d.projection.currentInvocation!;
  const token = await mint(inv.id, runId);
  const post = (events: unknown[]) =>
    ctx.post(`/internal/invocations/${inv.id}/events`, {
      headers: { authorization: `Bearer ${token}` },
      data: events,
    });
  await post([{ type: 'invocation.started', payload: { pod_name: `pod-${inv.id.slice(0, 4)}` } }]);
  const tail: unknown[] = [];
  for (let i = 0; i < (opts.tail ?? 3); i++) {
    tail.push({
      type: 'invocation.tool_use',
      payload: { tool: 'Read', summary: `read src/retry/policy.ts (+${40 + i} −12)` },
    });
  }
  tail.push({
    type: 'invocation.text',
    payload: { text: 'ceiling added: maxAttempts=5, window=10m ✓ B1' },
  });
  await post(tail);
  const events: unknown[] = [];
  if (inv.mate === 'implementer') {
    const changed = opts.changed ?? true;
    events.push({
      type: 'implementation.pushed',
      payload: {
        commit: 'abc1234',
        files_changed: changed ? 5 : 0,
        additions: changed ? 186 : 0,
        deletions: changed ? 31 : 0,
        changed_in_iteration: changed,
        diff_ref: null,
      },
    });
    events.push({
      type: 'implementation.tests',
      payload: {
        passed: 142,
        failed: 0,
        skipped: 0,
        runner: 'vitest',
        duration_ms: 9000,
        log_ref: null,
      },
    });
  }
  const result = fixtureResult(scenario);
  events.push({
    type: 'invocation.finished',
    payload: {
      exit_code: result.is_error ? 1 : 0,
      duration_ms: 1_080_000,
      session_id: null,
      result,
      transcript_ref: null,
    },
  });
  const r = await post(events);
  if (r.status() !== 202) throw new Error(`ingest failed: ${await r.text()}`);
  await new Promise((res) => setTimeout(res, 400));
  return (await (await ctx.get(`/api/runs/${runId}`)).json()) as Detail;
}

/** Leaves the invocation running after some tail lines (for the live tail). */
export async function startOnly(ctx: APIRequestContext, runId: string): Promise<Detail> {
  const d = await waitForInvocation(ctx, runId);
  const inv = d.projection.currentInvocation!;
  const token = await mint(inv.id, runId);
  await ctx.post(`/internal/invocations/${inv.id}/events`, {
    headers: { authorization: `Bearer ${token}` },
    data: [
      { type: 'invocation.started', payload: { pod_name: 'pod-live' } },
      {
        type: 'invocation.tool_use',
        payload: { tool: 'Read', summary: 'read src/retry/policy.ts (+41 −12)' },
      },
      {
        type: 'invocation.tool_use',
        payload: { tool: 'Bash', summary: 'run pnpm test --filter webhook-service' },
      },
      { type: 'invocation.text', payload: { text: 'dlq assertion covers exhausted path ✓ B2' } },
    ],
  });
  return d;
}
