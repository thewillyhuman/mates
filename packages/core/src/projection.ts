import type { EventPayload, Mate, ReviewItem, RunEvent } from './events.js';
import { isTerminal, type BlockedReason, type Stage } from './stage.js';

/**
 * `projectRun(events)` — the one function that turns a run's event log into
 * its current state (§4.3). API responses, the UI and the orchestrator all
 * use it; nothing else computes stage, iteration or totals.
 *
 * Pure: no clock, no I/O. Elapsed time is for the caller to compute from
 * `createdAt` and `finishedAt`.
 */

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of reported costs; null-cost records contribute 0. */
  costUsd: number;
}

export type InvocationStatus = 'scheduled' | 'running' | 'succeeded' | 'failed';

export interface InvocationView {
  id: string;
  mate: Mate;
  iteration: number;
  model: string;
  jobName: string;
  status: InvocationStatus;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  podName: string;
  sessionId: string | null;
  lastHeartbeatAt: string | null;
  /** Most recent condensed tool-use or text line, for board cards. */
  lastLine: string | null;
  failure: { reason: string; detail: string } | null;
  usage: UsageTotals;
}

export interface VerdictView {
  iteration: number;
  invocationId: string | null;
  decision: 'approve' | 'changes_requested';
  blocking: ReviewItem[];
  nonBlocking: ReviewItem[];
  summary: string;
  ts: string;
}

export interface IterationView {
  n: number;
  implementerId: string | null;
  reviewerId: string | null;
  pushed: EventPayload<'implementation.pushed'> | null;
  tests: EventPayload<'implementation.tests'> | null;
  addressed: EventPayload<'implementation.addressed'> | null;
  verdict: VerdictView | null;
}

export interface NudgeView {
  id: string;
  by: string;
  text: string;
  ts: string;
  consumedBy: string | null;
}

export interface MergeRequestView {
  id: string;
  url: string;
  draft: boolean;
}

export interface RunProjection {
  ticketKey: string;
  trigger: 'webhook' | 'poll' | 'manual';
  createdBy: string;
  createdAt: string;
  maxIterations: number;
  budgetUsd: number | null;

  stage: Stage;
  stageReason: string;
  stageChangedAt: string;
  blockedReason: BlockedReason | null;
  paused: boolean;
  finishedAt: string | null;

  /** Highest implementer iteration scheduled so far; 0 before the first. */
  iteration: number;
  intake: EventPayload<'intake.passed'> | null;
  clarificationRounds: number;
  questions: string[];

  invocations: InvocationView[];
  currentInvocation: InvocationView | null;
  iterations: IterationView[];
  verdicts: VerdictView[];
  lastVerdict: VerdictView | null;
  /** Iterations in which the implementer pushed no changes (§7.5 rule 5). */
  emptyIterations: number;

  mr: MergeRequestView | null;
  trackerStatus: string | null;
  nudges: NudgeView[];
  pendingNudges: NudgeView[];

  usage: UsageTotals;
  usageByMate: Record<Mate, UsageTotals>;
  failure: { reason: string; detail: string } | null;
  budgetExceeded: EventPayload<'run.budget_exceeded'> | null;

  lastEventId: number;
  lastEventAt: string;
  /** One line for the board card, e.g. "Iteration 2 · run pnpm test". */
  currentAction: string;
}

export class ProjectionError extends Error {}

function zeroUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

function addUsage(into: UsageTotals, u: EventPayload<'usage.recorded'>): void {
  into.inputTokens += u.input_tokens;
  into.outputTokens += u.output_tokens;
  into.cacheReadTokens += u.cache_read_tokens;
  into.cacheWriteTokens += u.cache_write_tokens;
  into.costUsd += u.cost_usd ?? 0;
}

function describeBlocked(
  reason: BlockedReason | null,
  p: Pick<RunProjection, 'questions' | 'lastVerdict' | 'maxIterations'>,
): string {
  switch (reason) {
    case 'needs_clarification':
      return p.questions[0]
        ? `Clarification requested — "${p.questions[0]}"`
        : 'Clarification requested';
    case 'iteration_cap':
      return `Iteration cap reached (${p.maxIterations}/${p.maxIterations}) · ${p.lastVerdict?.blocking.length ?? 0} unresolved review points`;
    case 'budget_exceeded':
      return 'Budget exceeded';
    default:
      return 'Blocked';
  }
}

export function projectRun(events: readonly RunEvent[]): RunProjection {
  const first = events[0];
  if (!first || first.type !== 'run.created') {
    throw new ProjectionError('event log must start with run.created');
  }
  const created = first.payload;

  const invocations = new Map<string, InvocationView>();
  const iterations = new Map<number, IterationView>();
  const iterationView = (n: number): IterationView => {
    let it = iterations.get(n);
    if (!it) {
      it = {
        n,
        implementerId: null,
        reviewerId: null,
        pushed: null,
        tests: null,
        addressed: null,
        verdict: null,
      };
      iterations.set(n, it);
    }
    return it;
  };
  const invocationOf = (e: RunEvent): InvocationView | undefined =>
    e.invocation_id ? invocations.get(e.invocation_id) : undefined;

  const p: RunProjection = {
    ticketKey: created.ticket_key,
    trigger: created.trigger,
    createdBy: created.by,
    createdAt: first.ts,
    maxIterations: created.max_iterations,
    budgetUsd: created.budget_usd,
    stage: 'queued',
    stageReason: 'created',
    stageChangedAt: first.ts,
    blockedReason: null,
    paused: false,
    finishedAt: null,
    iteration: 0,
    intake: null,
    clarificationRounds: 0,
    questions: [],
    invocations: [],
    currentInvocation: null,
    iterations: [],
    verdicts: [],
    lastVerdict: null,
    emptyIterations: 0,
    mr: null,
    trackerStatus: null,
    nudges: [],
    pendingNudges: [],
    usage: zeroUsage(),
    usageByMate: { intake: zeroUsage(), implementer: zeroUsage(), reviewer: zeroUsage() },
    failure: null,
    budgetExceeded: null,
    lastEventId: first.id,
    lastEventAt: first.ts,
    currentAction: '',
  };

  for (const e of events) {
    p.lastEventId = e.id;
    p.lastEventAt = e.ts;
    switch (e.type) {
      case 'run.created':
        break;
      case 'run.stage_changed':
        p.stage = e.payload.to;
        p.stageReason = e.payload.reason;
        p.stageChangedAt = e.ts;
        p.blockedReason = e.payload.to === 'blocked' ? (e.payload.reason as BlockedReason) : null;
        if (isTerminal(e.payload.to)) p.finishedAt = e.ts;
        break;
      case 'run.cancelled':
        break;
      case 'run.failed':
        p.failure = { reason: e.payload.reason, detail: e.payload.detail };
        break;
      case 'run.budget_exceeded':
        p.budgetExceeded = e.payload;
        break;
      case 'run.paused':
        p.paused = true;
        break;
      case 'run.resumed':
        p.paused = false;
        break;
      case 'intake.started':
      case 'intake.finished':
        break;
      case 'intake.needs_clarification':
        p.clarificationRounds += 1;
        p.questions = e.payload.questions;
        break;
      case 'intake.passed':
        p.intake = e.payload;
        p.questions = [];
        break;
      case 'invocation.scheduled': {
        if (!e.invocation_id)
          throw new ProjectionError(`event ${e.id}: invocation.scheduled without invocation_id`);
        const inv: InvocationView = {
          id: e.invocation_id,
          mate: e.payload.mate,
          iteration: e.payload.iteration,
          model: e.payload.model,
          jobName: e.payload.job_name,
          status: 'scheduled',
          scheduledAt: e.ts,
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          exitCode: null,
          podName: '',
          sessionId: null,
          lastHeartbeatAt: null,
          lastLine: null,
          failure: null,
          usage: zeroUsage(),
        };
        invocations.set(inv.id, inv);
        if (inv.mate === 'implementer') {
          p.iteration = Math.max(p.iteration, inv.iteration);
          iterationView(inv.iteration).implementerId = inv.id;
        } else if (inv.mate === 'reviewer') {
          iterationView(inv.iteration).reviewerId = inv.id;
        }
        break;
      }
      case 'invocation.started': {
        const inv = invocationOf(e);
        if (inv) {
          inv.status = 'running';
          inv.startedAt = e.ts;
          inv.podName = e.payload.pod_name;
        }
        break;
      }
      case 'invocation.heartbeat': {
        const inv = invocationOf(e);
        if (inv) inv.lastHeartbeatAt = e.ts;
        break;
      }
      case 'invocation.tool_use': {
        const inv = invocationOf(e);
        if (inv) inv.lastLine = e.payload.summary;
        break;
      }
      case 'invocation.text': {
        const inv = invocationOf(e);
        if (inv) inv.lastLine = e.payload.text.split('\n')[0] ?? '';
        break;
      }
      case 'invocation.finished': {
        const inv = invocationOf(e);
        if (inv) {
          inv.status = e.payload.exit_code === 0 ? 'succeeded' : 'failed';
          inv.finishedAt = e.ts;
          inv.durationMs = e.payload.duration_ms;
          inv.exitCode = e.payload.exit_code;
          inv.sessionId = e.payload.session_id;
        }
        break;
      }
      case 'invocation.failed': {
        const inv = invocationOf(e);
        if (inv) {
          inv.status = 'failed';
          inv.finishedAt = e.ts;
          inv.failure = { reason: e.payload.reason, detail: e.payload.detail };
        }
        break;
      }
      case 'implementation.pushed': {
        const inv = invocationOf(e);
        const n = inv?.iteration ?? p.iteration;
        iterationView(n).pushed = e.payload;
        if (e.payload.files_changed === 0) p.emptyIterations += 1;
        break;
      }
      case 'implementation.tests': {
        const inv = invocationOf(e);
        iterationView(inv?.iteration ?? p.iteration).tests = e.payload;
        break;
      }
      case 'implementation.addressed': {
        const inv = invocationOf(e);
        iterationView(inv?.iteration ?? p.iteration).addressed = e.payload;
        break;
      }
      case 'review.verdict': {
        const inv = invocationOf(e);
        const n = inv?.iteration ?? p.iteration;
        const v: VerdictView = {
          iteration: n,
          invocationId: e.invocation_id,
          decision: e.payload.decision,
          blocking: e.payload.blocking,
          nonBlocking: e.payload.non_blocking,
          summary: e.payload.summary,
          ts: e.ts,
        };
        p.verdicts.push(v);
        p.lastVerdict = v;
        iterationView(n).verdict = v;
        break;
      }
      case 'mr.opened':
        p.mr = { id: e.payload.mr_id, url: e.payload.url, draft: e.payload.draft };
        break;
      case 'mr.updated':
        break;
      case 'mr.marked_ready':
        if (p.mr) p.mr = { ...p.mr, draft: false };
        break;
      case 'tracker.transitioned':
        p.trackerStatus = e.payload.to;
        break;
      case 'tracker.commented':
        break;
      case 'nudge.added':
        p.nudges.push({
          id: e.payload.nudge_id,
          by: e.payload.by,
          text: e.payload.text,
          ts: e.ts,
          consumedBy: null,
        });
        break;
      case 'nudge.consumed': {
        const n = p.nudges.find((x) => x.id === e.payload.nudge_id);
        if (n) n.consumedBy = e.payload.invocation_id;
        break;
      }
      case 'usage.recorded': {
        addUsage(p.usage, e.payload);
        const inv = invocationOf(e);
        if (inv) {
          addUsage(inv.usage, e.payload);
          addUsage(p.usageByMate[inv.mate], e.payload);
        }
        break;
      }
      default: {
        const never: never = e;
        throw new ProjectionError(`unhandled event ${String((never as RunEvent).type)}`);
      }
    }
  }

  p.invocations = [...invocations.values()];
  p.currentInvocation =
    [...invocations.values()]
      .reverse()
      .find((i) => i.status === 'scheduled' || i.status === 'running') ?? null;
  p.iterations = [...iterations.values()].sort((a, b) => a.n - b.n);
  p.pendingNudges = p.nudges.filter((n) => n.consumedBy === null);
  p.currentAction = currentAction(p);
  return p;
}

function currentAction(p: RunProjection): string {
  const inv = p.currentInvocation;
  const line = inv?.lastLine ? ` · ${inv.lastLine}` : '';
  switch (p.stage) {
    case 'queued':
      return p.paused ? 'Paused' : 'In queue';
    case 'intake':
      return inv?.status === 'running' ? `Reading ticket${line}` : 'Starting intake';
    case 'implementing':
      return `Iteration ${Math.max(p.iteration, 1)}${inv?.status === 'running' ? line || ' · working' : ' · starting'}`;
    case 'reviewing':
      return `Review ${Math.max(p.iteration, 1)}${inv?.status === 'running' ? line || ' · reviewer reading diff' : ' · starting'}`;
    case 'mr_ready':
      return `Approved after ${p.iteration} iteration${p.iteration === 1 ? '' : 's'} · waiting on human`;
    case 'blocked':
      return describeBlocked(p.blockedReason, p);
    case 'done':
      return `Done · ${p.iteration} iteration${p.iteration === 1 ? '' : 's'}`;
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return `Failed · ${p.failure?.reason ?? 'unknown'}`;
  }
}
