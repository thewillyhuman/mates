import { describe, expect, it } from 'vitest';
import type { EventPayload, EventType, RunEvent } from './events.js';
import { ProjectionError, projectRun } from './projection.js';

/** Builds a chronological log; each call is one minute after the previous. */
function log() {
  const events: RunEvent[] = [];
  let t = Date.UTC(2026, 9, 19, 14, 0, 0);
  const add = <T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    invocationId: string | null = null,
  ) => {
    t += 60_000;
    events.push({
      id: events.length + 1,
      run_id: 'run-1',
      invocation_id: invocationId,
      ts: new Date(t).toISOString(),
      type,
      payload,
    } as RunEvent);
    return api;
  };
  const api = { add, events };
  return api;
}

const created = (): EventPayload<'run.created'> => ({
  ticket_key: 'API-198',
  trigger: 'manual',
  by: 'ana',
  max_iterations: 4,
  budget_usd: 25,
});

const usage = (cost: number): EventPayload<'usage.recorded'> => ({
  model: 'claude-opus-5-5',
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 50,
  cache_write_tokens: 10,
  cost_usd: cost,
});

describe('projectRun', () => {
  it('starts queued with the cap and budget from run.created', () => {
    const p = projectRun(log().add('run.created', created()).events);
    expect(p).toMatchObject({
      ticketKey: 'API-198',
      stage: 'queued',
      iteration: 0,
      maxIterations: 4,
      budgetUsd: 25,
      paused: false,
      currentAction: 'In queue',
    });
    expect(p.usage.costUsd).toBe(0);
  });

  it('rejects a log that does not start with run.created', () => {
    expect(() => projectRun([])).toThrow(ProjectionError);
    expect(() => projectRun(log().add('run.paused', { by: 'x' }).events)).toThrow(ProjectionError);
  });

  it('follows the happy path to done and sums usage per mate', () => {
    const l = log()
      .add('run.created', created())
      .add('run.stage_changed', { from: 'queued', to: 'intake', reason: 'scheduled' })
      .add(
        'invocation.scheduled',
        { mate: 'intake', iteration: 0, job_name: 'j-in', model: 'claude-sonnet-5-5' },
        'inv-in',
      )
      .add('invocation.started', { pod_name: 'p1' }, 'inv-in')
      .add(
        'invocation.finished',
        { exit_code: 0, duration_ms: 1000, session_id: 's', result: null },
        'inv-in',
      )
      .add('usage.recorded', usage(0.5), 'inv-in')
      .add('intake.passed', {
        repo: 'webhook-service',
        base_branch: 'main',
        plan: ['a'],
        scope_notes: '',
      })
      .add('run.stage_changed', { from: 'intake', to: 'implementing', reason: 'intake_passed' })
      .add(
        'invocation.scheduled',
        { mate: 'implementer', iteration: 1, job_name: 'j-i1', model: 'claude-opus-5-5' },
        'inv-i1',
      )
      .add('invocation.started', { pod_name: 'p2' }, 'inv-i1')
      .add('invocation.tool_use', { tool: 'Bash', summary: 'run pnpm test' }, 'inv-i1')
      .add(
        'implementation.pushed',
        { commit: 'abc', files_changed: 5, additions: 186, deletions: 31 },
        'inv-i1',
      )
      .add(
        'implementation.tests',
        { passed: 142, failed: 0, skipped: 0, runner: 'vitest', duration_ms: 9000, log_ref: 'b1' },
        'inv-i1',
      )
      .add(
        'invocation.finished',
        { exit_code: 0, duration_ms: 1000, session_id: null, result: null },
        'inv-i1',
      )
      .add('usage.recorded', usage(3), 'inv-i1')
      .add('mr.opened', {
        mr_id: '1429',
        url: 'https://gitlab/x/-/merge_requests/1429',
        draft: true,
      })
      .add('run.stage_changed', { from: 'implementing', to: 'reviewing', reason: 'pushed' })
      .add(
        'invocation.scheduled',
        { mate: 'reviewer', iteration: 1, job_name: 'j-r1', model: 'claude-opus-5-5' },
        'inv-r1',
      )
      .add('invocation.started', { pod_name: 'p3' }, 'inv-r1')
      .add(
        'review.verdict',
        { decision: 'approve', blocking: [], non_blocking: [], summary: 'LGTM' },
        'inv-r1',
      )
      .add(
        'invocation.finished',
        { exit_code: 0, duration_ms: 1000, session_id: null, result: null },
        'inv-r1',
      )
      .add('usage.recorded', usage(2), 'inv-r1')
      .add('mr.marked_ready', { mr_id: '1429' })
      .add('run.stage_changed', { from: 'reviewing', to: 'mr_ready', reason: 'approved' })
      .add('run.stage_changed', { from: 'mr_ready', to: 'done', reason: 'mr_ready' });
    const p = projectRun(l.events);
    expect(p.stage).toBe('done');
    expect(p.finishedAt).toBe(l.events.at(-1)!.ts);
    expect(p.iteration).toBe(1);
    expect(p.intake?.repo).toBe('webhook-service');
    expect(p.mr).toEqual({
      id: '1429',
      url: 'https://gitlab/x/-/merge_requests/1429',
      draft: false,
    });
    expect(p.invocations.map((i) => [i.mate, i.status])).toEqual([
      ['intake', 'succeeded'],
      ['implementer', 'succeeded'],
      ['reviewer', 'succeeded'],
    ]);
    expect(p.currentInvocation).toBeNull();
    expect(p.iterations).toHaveLength(1);
    expect(p.iterations[0]).toMatchObject({
      n: 1,
      implementerId: 'inv-i1',
      reviewerId: 'inv-r1',
      pushed: { files_changed: 5 },
      tests: { passed: 142 },
      verdict: { decision: 'approve' },
    });
    expect(p.usage.costUsd).toBe(5.5);
    expect(p.usage.inputTokens).toBe(3000);
    expect(p.usageByMate.implementer.costUsd).toBe(3);
    expect(p.usageByMate.reviewer.costUsd).toBe(2);
    expect(p.invocations[1]!.usage.costUsd).toBe(3);
    expect(p.lastVerdict?.decision).toBe('approve');
    expect(p.currentAction).toBe('Done · 1 iteration');
  });

  it('tracks the iteration loop and the cap', () => {
    const l = log().add('run.created', created());
    l.add('run.stage_changed', { from: 'queued', to: 'intake', reason: 'scheduled' });
    l.add('intake.passed', { repo: 'r', base_branch: 'main', plan: [], scope_notes: '' });
    l.add('run.stage_changed', { from: 'intake', to: 'implementing', reason: 'intake_passed' });
    for (let n = 1; n <= 4; n++) {
      l.add(
        'invocation.scheduled',
        { mate: 'implementer', iteration: n, job_name: `i${n}`, model: 'm' },
        `inv-i${n}`,
      );
      l.add(
        'implementation.pushed',
        { commit: 'c', files_changed: 1, additions: 1, deletions: 0 },
        `inv-i${n}`,
      );
      l.add('run.stage_changed', { from: 'implementing', to: 'reviewing', reason: 'pushed' });
      l.add(
        'invocation.scheduled',
        { mate: 'reviewer', iteration: n, job_name: `r${n}`, model: 'm' },
        `inv-r${n}`,
      );
      l.add(
        'review.verdict',
        {
          decision: 'changes_requested',
          blocking: [{ id: 'B1', title: 'Unbounded backoff', detail: '', file: null, line: null }],
          non_blocking: [],
          summary: 'no',
        },
        `inv-r${n}`,
      );
      if (n < 4)
        l.add('run.stage_changed', {
          from: 'reviewing',
          to: 'implementing',
          reason: 'changes_requested',
        });
    }
    l.add('run.stage_changed', { from: 'reviewing', to: 'blocked', reason: 'iteration_cap' });
    const p = projectRun(l.events);
    expect(p.stage).toBe('blocked');
    expect(p.blockedReason).toBe('iteration_cap');
    expect(p.iteration).toBe(4);
    expect(p.verdicts).toHaveLength(4);
    expect(p.iterations.map((i) => i.n)).toEqual([1, 2, 3, 4]);
    expect(p.currentAction).toBe('Iteration cap reached (4/4) · 1 unresolved review points');
  });

  it('counts clarification rounds and surfaces the question while blocked', () => {
    const p = projectRun(
      log()
        .add('run.created', created())
        .add('run.stage_changed', { from: 'queued', to: 'intake', reason: 'scheduled' })
        .add('intake.needs_clarification', { questions: ['Which tier?'], tracker_comment_id: '7' })
        .add('run.stage_changed', { from: 'intake', to: 'blocked', reason: 'needs_clarification' })
        .events,
    );
    expect(p.clarificationRounds).toBe(1);
    expect(p.blockedReason).toBe('needs_clarification');
    expect(p.currentAction).toBe('Clarification requested — "Which tier?"');
  });

  it('counts empty iterations and records failure', () => {
    const p = projectRun(
      log()
        .add('run.created', created())
        .add(
          'invocation.scheduled',
          { mate: 'implementer', iteration: 1, job_name: 'i1', model: 'm' },
          'i1',
        )
        .add(
          'implementation.pushed',
          { commit: 'c', files_changed: 0, additions: 0, deletions: 0 },
          'i1',
        )
        .add(
          'invocation.scheduled',
          { mate: 'implementer', iteration: 2, job_name: 'i2', model: 'm' },
          'i2',
        )
        .add(
          'implementation.pushed',
          { commit: 'c', files_changed: 0, additions: 0, deletions: 0 },
          'i2',
        )
        .add('run.failed', { reason: 'empty_diff', detail: 'two iterations without changes' })
        .add('run.stage_changed', { from: 'implementing', to: 'failed', reason: 'empty_diff' })
        .events,
    );
    expect(p.emptyIterations).toBe(2);
    expect(p.stage).toBe('failed');
    expect(p.failure?.reason).toBe('empty_diff');
    expect(p.currentAction).toBe('Failed · empty_diff');
  });

  it('exposes the running invocation with its last line and heartbeat', () => {
    const l = log()
      .add('run.created', created())
      .add('run.stage_changed', { from: 'queued', to: 'intake', reason: 'scheduled' })
      .add(
        'invocation.scheduled',
        { mate: 'intake', iteration: 0, job_name: 'j', model: 'm' },
        'inv',
      )
      .add('invocation.started', { pod_name: 'pod-1' }, 'inv')
      .add('invocation.heartbeat', {}, 'inv')
      .add('invocation.tool_use', { tool: 'Read', summary: 'read src/retry/policy.ts' }, 'inv');
    const p = projectRun(l.events);
    expect(p.currentInvocation).toMatchObject({
      id: 'inv',
      status: 'running',
      podName: 'pod-1',
      lastLine: 'read src/retry/policy.ts',
      lastHeartbeatAt: l.events[4]!.ts,
    });
    expect(p.currentAction).toBe('Reading ticket · read src/retry/policy.ts');
  });

  it('marks a failed invocation and keeps its reason', () => {
    const p = projectRun(
      log()
        .add('run.created', created())
        .add(
          'invocation.scheduled',
          { mate: 'implementer', iteration: 1, job_name: 'j', model: 'm' },
          'inv',
        )
        .add('invocation.failed', { reason: 'setup_failed', detail: 'pnpm install exit 1' }, 'inv')
        .events,
    );
    expect(p.invocations[0]).toMatchObject({
      status: 'failed',
      failure: { reason: 'setup_failed' },
    });
    expect(p.currentInvocation).toBeNull();
  });

  it('tracks nudges until consumed, pause state and budget', () => {
    const p = projectRun(
      log()
        .add('run.created', created())
        .add('nudge.added', { nudge_id: 'n1', by: 'ana', text: 'Use BackoffSchedule' })
        .add('nudge.added', { nudge_id: 'n2', by: 'bob', text: 'Add a test' })
        .add('nudge.consumed', { nudge_id: 'n1', invocation_id: 'inv-2' })
        .add('run.paused', { by: 'ana' })
        .add('run.budget_exceeded', { kind: 'usd', limit: 25, used: 26.1 })
        .add('run.stage_changed', { from: 'queued', to: 'blocked', reason: 'budget_exceeded' })
        .events,
    );
    expect(p.nudges).toHaveLength(2);
    expect(p.pendingNudges.map((n) => n.id)).toEqual(['n2']);
    expect(p.nudges[0]?.consumedBy).toBe('inv-2');
    expect(p.paused).toBe(true);
    expect(p.budgetExceeded?.used).toBe(26.1);
    expect(p.blockedReason).toBe('budget_exceeded');
  });

  it('records cancellation and tracker status', () => {
    const p = projectRun(
      log()
        .add('run.created', created())
        .add('tracker.transitioned', { from: 'To Do', to: 'In Progress' })
        .add('run.cancelled', { by: 'ana', reason: 'duplicate' })
        .add('run.stage_changed', { from: 'queued', to: 'cancelled', reason: 'duplicate' }).events,
    );
    expect(p.stage).toBe('cancelled');
    expect(p.trackerStatus).toBe('In Progress');
    expect(p.finishedAt).not.toBeNull();
  });
});
