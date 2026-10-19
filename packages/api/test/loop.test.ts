import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeResult, RunProjection } from '@mates/core';
import { mintInvocationToken } from '../src/auth/invocation-token.js';
import { packageOf } from '../src/team-context/service.test.js';
import { stopTestDatabase } from './db.js';
import { INTERNAL_KEY, testApp, type TestApp } from './harness.js';

/**
 * The §7.5 loop, driven by the fake-Claude fixtures: each scheduled
 * invocation is "run" by posting the runner's events (started, push, tests,
 * finished with the fixture's final result line) to the ingest endpoint.
 */
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/claude',
);

function fixtureResult(scenario: string): ClaudeResult {
  const lines = readFileSync(path.join(FIXTURES, `${scenario}.jsonl`), 'utf8')
    .trim()
    .split('\n');
  return JSON.parse(lines.at(-1)!) as ClaudeResult;
}

const manifest = `
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

type Detail = { id: string; branch: string | null; projection: RunProjection };

describe('the loop (§7.5)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await testApp();
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
      await packageOf({ 'mates.yaml': manifest, 'docs/conventions.md': '# conv' }),
      'admin@example.com',
    );
  });
  afterAll(async () => {
    await t.close();
    await stopTestDatabase();
  });

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

  it('approves on iteration 1: intake → implementer → reviewer → mr_ready → done, with Jira and MR effects', async () => {
    const run = await trigger('API-101', 'Retry policy');
    let d = await reconcile(run.id);
    expect(d.projection.stage).toBe('intake');
    expect(t.tracker.transitions.at(-1)).toEqual({ key: 'API-101', to: 'Triage' });

    d = await play(run.id, 'intake_implementable');
    expect(d.projection.intake).toMatchObject({ repo: 'webhook-service', base_branch: 'main' });
    expect(d.projection.stage).toBe('implementing');
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'implementer', iteration: 1 });
    expect(t.tracker.transitions.at(-1)).toEqual({ key: 'API-101', to: 'In Progress' });
    const ticket = await t.db.pool.query<{ repo_id: string }>(
      "SELECT repo_id FROM tickets WHERE external_key = 'API-101'",
    );
    expect(ticket.rows[0]?.repo_id).toBe('webhook-service');

    d = await play(run.id, 'impl_iter1_green');
    expect(d.projection.mr).toMatchObject({ id: '1401', draft: true });
    expect(t.scm.mrs.get('1401')).toMatchObject({
      sourceBranch: 'mates/API-101-retry-policy',
      targetBranch: 'main',
      title: 'API-101: Retry policy',
      labels: ['mates'],
    });
    expect(t.scm.mrs.get('1401')!.description).toContain('## Changes per iteration');
    expect(d.projection.stage).toBe('reviewing');
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'reviewer', iteration: 1 });

    d = await play(run.id, 'review_approve');
    expect(d.projection.lastVerdict?.decision).toBe('approve');
    expect(d.projection.stage).toBe('done');
    expect(d.projection.mr?.draft).toBe(false);
    expect(t.scm.mrs.get('1401')?.state).toBe('ready');
    expect(t.scm.mrs.get('1401')!.description).toContain('Retry attempts are capped at five');
    expect(t.tracker.transitions.at(-1)).toEqual({ key: 'API-101', to: 'In Review' });
    const comment = t.tracker.comments.find((c) => c.key === 'API-101' && c.kind === 'status');
    expect(comment?.markdown).toMatch(
      /ready for human review.*Cost: \$\d+\.\d\d · 1 iteration · claude-sonnet-5-5, claude-opus-5-5/s,
    );
    expect(d.projection.usage.costUsd).toBeCloseTo(0.0412 + 1.8734 + 0.8117, 4);
    expect(d.projection.usageByMate.reviewer.costUsd).toBeCloseTo(0.8117, 4);
    const verdicts = await t.db.pool.query<{ decision: string }>(
      'SELECT decision FROM verdicts WHERE run_id = $1',
      [run.id],
    );
    expect(verdicts.rows).toEqual([{ decision: 'approve' }]);
    expect(t.jobs.jobs.size).toBeGreaterThanOrEqual(3);
  });

  it('approves on iteration 3 after two changes-requested verdicts, carrying the verdict into the next brief', async () => {
    const run = await trigger('API-102', 'Paginate orders');
    await reconcile(run.id);
    let d = await play(run.id, 'intake_implementable');
    d = await play(run.id, 'impl_iter1_green');
    d = await play(run.id, 'review_changes_requested_2_blocking');
    expect(d.projection.stage).toBe('implementing');
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'implementer', iteration: 2 });
    expect(d.projection.lastVerdict?.blocking.map((b) => b.id)).toEqual(['B1', 'B2']);

    // The implementer's brief for iteration 2 carries B1/B2.
    const inv = d.projection.currentInvocation!;
    const token = await mintInvocationToken(
      INTERNAL_KEY,
      { invocationId: inv.id, runId: run.id },
      600,
    );
    const ctx = await t.app.inject({
      url: `/internal/invocations/${inv.id}/context`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ctx.statusCode).toBe(200);
    const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tar = await import('tar');
    const dir = await mkdtemp(path.join(tmpdir(), 'mates-loop-'));
    await writeFile(path.join(dir, 'b.tgz'), ctx.rawPayload);
    await tar.x({ file: path.join(dir, 'b.tgz'), cwd: dir });
    const brief = await readFile(path.join(dir, 'brief.md'), 'utf8');
    expect(brief).toContain('(iteration 2 of 4)');
    expect(brief).toContain('- B1 **Backoff is unbounded**');
    expect(brief).toContain('- B2 **No test covers the dead-letter path**');

    d = await play(run.id, 'impl_iter2_addressed');
    expect(d.projection.stage).toBe('reviewing');
    expect(d.projection.iterations[1]?.addressed).toBeNull(); // the test runner did not post an addressed event
    d = await play(run.id, 'review_changes_requested_2_blocking');
    d = await play(run.id, 'impl_iter2_addressed');
    d = await play(run.id, 'review_approve');
    expect(d.projection.stage).toBe('done');
    expect(d.projection.iteration).toBe(3);
    expect(d.projection.verdicts.map((v) => v.decision)).toEqual([
      'changes_requested',
      'changes_requested',
      'approve',
    ]);
    const mr = [...t.scm.mrs.values()].find(
      (m) => m.sourceBranch === 'mates/API-102-paginate-orders',
    )!;
    expect(mr.description).toContain('- Iteration 3:');
    expect(mr.state).toBe('ready');
  });

  it('blocks at the iteration cap with the unresolved points in the MR, then allows one more iteration on retry', async () => {
    const run = await trigger('API-103', 'Cap me');
    await reconcile(run.id);
    let d = await play(run.id, 'intake_implementable');
    for (let n = 1; n <= 4; n++) {
      d = await play(run.id, 'impl_iter1_green');
      d = await play(run.id, 'review_changes_requested_2_blocking');
    }
    expect(d.projection.stage).toBe('blocked');
    expect(d.projection.blockedReason).toBe('iteration_cap');
    expect(d.projection.iteration).toBe(4);
    const mr = [...t.scm.mrs.values()].find((m) => m.sourceBranch === 'mates/API-103-cap-me')!;
    expect(mr.state).toBe('draft');
    expect(mr.description).toContain('## Unresolved review points');
    expect(mr.description).toContain('- [ ] **B1** Backoff is unbounded');
    expect(t.tracker.transitions.at(-1)).toEqual({ key: 'API-103', to: 'Needs Info' });
    expect(t.tracker.comments.at(-1)?.markdown).toContain(
      'Iteration cap reached (4/4) with 2 unresolved review points',
    );
    expect(d.projection.currentAction).toBe(
      'Iteration cap reached (4/4) · 2 unresolved review points',
    );

    // A nudge with "and retry" re-queues; one more iteration runs with the nudge in its brief.
    const nudged = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/nudges`,
      payload: {
        text: 'Use the shared BackoffSchedule helper.',
        post_to_tracker: true,
        and_retry: true,
      },
      headers: t.as('operator'),
    });
    expect(nudged.statusCode).toBe(201);
    expect(t.tracker.comments.at(-1)).toMatchObject({ kind: 'nudge_echo' });
    d = await reconcile(run.id);
    expect(d.projection.stage).toBe('implementing');
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'implementer', iteration: 5 });
    expect(d.projection.capResumes).toBe(1);
    expect(d.projection.pendingNudges).toEqual([]);
    expect(d.projection.nudges[0]?.consumedBy).toBe(d.projection.currentInvocation!.id);
    d = await play(run.id, 'impl_iter2_addressed');
    d = await play(run.id, 'review_changes_requested_2_blocking');
    expect(d.projection.stage).toBe('blocked');
    expect(d.projection.iteration).toBe(5);
  });

  it('asks for clarification, blocks, and resumes intake when a human answers; three rounds fail the run', async () => {
    const run = await trigger('API-104', 'Ambiguous');
    await reconcile(run.id);
    let d = await play(run.id, 'intake_needs_clarification');
    expect(d.projection.stage).toBe('blocked');
    expect(d.projection.blockedReason).toBe('needs_clarification');
    expect(d.projection.questions).toEqual([
      'The ticket lists both 100 req/min and 1 000 req/min. Which applies to the free tier?',
    ]);
    const q = t.tracker.comments.find((c) => c.key === 'API-104' && c.kind === 'clarification')!;
    expect(q.markdown).toContain('🤖 Mates: This ticket needs clarification');
    expect(q.markdown).toContain('- The ticket lists both');
    expect(q.markdown).toContain('http://mates.test/runs/');

    const answer = await t.app.inject({
      method: 'POST',
      url: '/webhooks/jira',
      payload: [
        {
          type: 'comment_created',
          key: 'API-104',
          id: 'id',
          commentId: '9',
          author: 'Ana',
          authorIsSelf: false,
          body: '100 req/min.',
        },
      ],
      headers: { 'x-mates-secret': 'fake-secret' },
    });
    expect(answer.json()).toMatchObject({ requeued: 1 });
    d = await reconcile(run.id);
    expect(d.projection.stage).toBe('intake');
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'intake', iteration: 0 });
    d = await play(run.id, 'intake_implementable');
    expect(d.projection.stage).toBe('implementing');
    expect(d.projection.clarificationRounds).toBe(1);

    const loop = await trigger('API-105', 'Never clear');
    for (let round = 1; round <= 3; round++) {
      await reconcile(loop.id);
      d = await play(loop.id, 'intake_needs_clarification');
      expect(d.projection.stage).toBe('blocked');
      await t.app.inject({
        method: 'POST',
        url: '/webhooks/jira',
        payload: [
          {
            type: 'comment_created',
            key: 'API-105',
            id: 'id',
            commentId: `c${round}`,
            author: 'Ana',
            authorIsSelf: false,
            body: 'still unclear',
          },
        ],
        headers: { 'x-mates-secret': 'fake-secret' },
      });
    }
    d = await reconcile(loop.id);
    expect(d.projection.stage).toBe('failed');
    expect(d.projection.failure?.reason).toBe('clarification_limit');
  });

  it('turns one empty diff into a synthetic verdict and two into a failure', async () => {
    const run = await trigger('API-106', 'Nothing to do');
    await reconcile(run.id);
    let d = await play(run.id, 'intake_implementable');
    d = await play(run.id, 'impl_empty_diff', { changed: false });
    expect(d.projection.stage).toBe('implementing');
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'implementer', iteration: 2 });
    expect(d.projection.verdicts[0]).toMatchObject({
      decision: 'changes_requested',
      blocking: [{ id: 'B0', title: 'No changes produced' }],
    });
    expect(d.projection.mr).toBeNull();
    d = await play(run.id, 'impl_empty_diff', { changed: false });
    expect(d.projection.stage).toBe('failed');
    expect(d.projection.failure?.reason).toBe('empty_diff');
    expect(t.tracker.comments.at(-1)?.markdown).toContain('The run failed: empty_diff');
  });

  it('blocks when Claude stops for budget, and resumes where it was after a retry with a raised budget', async () => {
    const run = await trigger('API-107', 'Expensive');
    await reconcile(run.id);
    let d = await play(run.id, 'intake_implementable');
    d = await play(run.id, 'impl_budget_exceeded', { changed: false });
    expect(d.projection.stage).toBe('blocked');
    expect(d.projection.blockedReason).toBe('budget_exceeded');
    expect(d.projection.budgetExceeded).toMatchObject({ kind: 'usd', used: 5.0213 });
    expect(t.tracker.comments.at(-1)?.markdown).toContain('Budget exceeded');

    // Per-run budget: cost so far exceeds the run budget → blocked again before the next spawn.
    const retry = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/retry`,
      payload: { budget_usd: 3 },
      headers: t.as('operator'),
    });
    expect(retry.statusCode).toBe(200);
    d = await reconcile(run.id);
    expect(d.projection.stage).toBe('blocked');
    expect(d.projection.budgetUsd).toBe(3);
    expect(d.projection.budgetExceeded).toMatchObject({ limit: 3 });

    const raised = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/retry`,
      payload: { budget_usd: 100 },
      headers: t.as('operator'),
    });
    expect(raised.statusCode).toBe(200);
    d = await reconcile(run.id);
    expect(d.projection.stage).toBe('implementing');
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'implementer', iteration: 1 });
    expect(d.projection.resumedFrom).toBe('budget_exceeded');
  });

  it('pauses after the current invocation and resumes', async () => {
    const run = await trigger('API-108', 'Pause me');
    await reconcile(run.id);
    const paused = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/pause`,
      headers: t.as('operator'),
    });
    expect(paused.json<Detail>().projection.paused).toBe(true);
    let d = await play(run.id, 'intake_implementable');
    expect(d.projection.intake).not.toBeNull();
    expect(d.projection.currentInvocation).toBeNull();
    expect(d.projection.stage).toBe('intake');
    expect(d.projection.currentAction).toBe('Starting intake');
    const resumed = await t.app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/resume`,
      headers: t.as('operator'),
    });
    expect(resumed.json<Detail>().projection.paused).toBe(false);
    d = await reconcile(run.id);
    expect(d.projection.stage).toBe('implementing');
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'implementer', iteration: 1 });
  });

  it('keeps runs queued when the daily budget is spent', async () => {
    await t.settings.update({ limits: { per_day_usd: 0.01 } }, 'admin@example.com');
    try {
      const run = await trigger('API-109', 'Too late today');
      await reconcile(run.id);
      let d = await play(run.id, 'intake_implementable');
      expect(d.projection.stage).toBe('intake');
      expect(d.projection.currentInvocation).toBeNull();
      await t.settings.update({ limits: { per_day_usd: 1000 } }, 'admin@example.com');
      d = await reconcile(run.id);
      expect(d.projection.stage).toBe('implementing');
    } finally {
      await t.settings.update({ limits: { per_day_usd: 1000 } }, 'admin@example.com');
    }
  });

  it('retries an infra failure of the implementer and continues the loop', async () => {
    const run = await trigger('API-110', 'Flaky infra');
    await reconcile(run.id);
    let d = await play(run.id, 'intake_implementable');
    d = await play(run.id, 'impl_iter1_green', { fail: 'setup_failed' });
    expect(d.projection.currentInvocation).toMatchObject({ mate: 'implementer', iteration: 1 });
    expect(d.projection.currentInvocation!.jobName).toMatch(/-r1$/);
    d = await play(run.id, 'impl_iter1_green');
    expect(d.projection.stage).toBe('reviewing');
  });
});
