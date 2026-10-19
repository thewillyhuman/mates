import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { ClaudeResult, RunProjection } from '@mates/core';
import { mintInvocationToken } from '../src/auth/invocation-token.js';
import { packageOf } from '../src/team-context/service.test.js';
import { INTERNAL_KEY, type TestApp } from './harness.js';

/**
 * Drives the §7.5 loop in tests: each scheduled invocation is "run" by
 * posting the runner's events (started, push, tests, finished with the
 * fixture's final result line) to the ingest endpoint, then reconciling.
 */
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/claude',
);

export function fixtureResult(scenario: string): ClaudeResult {
  const lines = readFileSync(path.join(FIXTURES, `${scenario}.jsonl`), 'utf8')
    .trim()
    .split('\n');
  return JSON.parse(lines.at(-1)!) as ClaudeResult;
}

export const LOOP_MANIFEST = `
version: 1
team:
  name: Loop team
  conventions: docs/conventions.md
repos:
  - id: webhook-service
    scm: gitlab
    project: platform/webhook-service
    jira_projects: [API]
    test: pnpm test
branching:
  pattern: "mates/{ticket}-{slug}"
`;

export type Detail = { id: string; branch: string | null; projection: RunProjection };

/** Configures a GitLab provider, Jira status map and the loop manifest on a fresh app. */
export async function configureLoop(t: TestApp): Promise<void> {
  await t.settings.update(
    {
      scm: {
        providers: [
          {
            id: 'gitlab',
            type: 'gitlab',
            base_url: 'https://gitlab.example.com',
            labels: ['mates'],
          },
        ],
      },
      jira: {
        status_map: {
          intake: 'Triage',
          in_progress: 'In Progress',
          mr_ready: 'In Review',
          blocked: 'Needs Info',
        },
        trigger: { kind: 'assignee', value: 'mates' },
      },
      limits: { max_iterations: 4, per_run_usd: 25, per_day_usd: 1000 },
    },
    'admin@example.com',
  );
  await t.teamContext.upload(
    await packageOf({ 'mates.yaml': LOOP_MANIFEST, 'docs/conventions.md': '# conv' }),
    'admin@example.com',
  );
}

export function loopDriver(t: TestApp) {
  async function detail(id: string): Promise<Detail> {
    return (await t.app.inject({ url: `/api/runs/${id}`, headers: t.as('viewer') })).json<Detail>();
  }
  async function trigger(key: string, title = `Ticket ${key}`): Promise<Detail> {
    t.tracker.seed(key, title, { description: 'desc', acceptance_criteria: 'AC', status: 'To Do' });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ticket_key: key },
      headers: t.as('operator'),
    });
    expect(res.statusCode).toBe(201);
    return res.json<Detail>();
  }
  /** Plays the runner for the current invocation with a fixture, then reconciles. */
  async function play(
    runId: string,
    scenario: string,
    opts: { changed?: boolean; fail?: string } = {},
  ): Promise<Detail> {
    let d = await detail(runId);
    const inv = d.projection.currentInvocation;
    expect(
      inv,
      `no invocation to play for ${scenario} (stage ${d.projection.stage})`,
    ).not.toBeNull();
    const token = await mintInvocationToken(INTERNAL_KEY, { invocationId: inv!.id, runId }, 600);
    const post = (events: unknown[]) =>
      t.app.inject({
        method: 'POST',
        url: `/internal/invocations/${inv!.id}/events`,
        headers: { authorization: `Bearer ${token}` },
        payload: events,
      });
    expect(
      (
        await post([
          { type: 'invocation.started', payload: { pod_name: `pod-${inv!.id.slice(0, 4)}` } },
        ])
      ).statusCode,
    ).toBe(202);
    if (opts.fail) {
      await post([{ type: 'invocation.failed', payload: { reason: opts.fail, detail: 'x' } }]);
    } else {
      const events: unknown[] = [
        { type: 'invocation.tool_use', payload: { tool: 'Read', summary: 'read x' } },
      ];
      if (inv!.mate === 'implementer') {
        const changed = opts.changed ?? true;
        events.push({
          type: 'implementation.pushed',
          payload: {
            commit: 'abc',
            files_changed: changed ? 3 : 0,
            additions: changed ? 20 : 0,
            deletions: changed ? 2 : 0,
            changed_in_iteration: changed,
            diff_ref: null,
          },
        });
        events.push({
          type: 'implementation.tests',
          payload: {
            passed: 5,
            failed: 0,
            skipped: 0,
            runner: 'vitest',
            duration_ms: 10,
            log_ref: null,
          },
        });
      }
      const result = fixtureResult(scenario);
      events.push({
        type: 'invocation.finished',
        payload: {
          exit_code: result.is_error ? 1 : 0,
          duration_ms: 1000,
          session_id: result.session_id ?? null,
          result,
          transcript_ref: null,
        },
      });
      expect((await post(events)).statusCode).toBe(202);
    }
    await t.orchestrator.reconcileRun(runId);
    d = await detail(runId);
    return d;
  }
  async function reconcile(runId: string): Promise<Detail> {
    await t.orchestrator.reconcileRun(runId);
    return detail(runId);
  }
  return { detail, trigger, play, reconcile };
}
