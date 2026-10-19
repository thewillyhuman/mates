/**
 * Run stages and the state machine of §4.2.
 *
 * The table below is the single definition of which transitions are legal.
 * The orchestrator asserts against it before emitting `run.stage_changed`;
 * the projection trusts the log.
 */
export const STAGES = [
  'queued',
  'intake',
  'implementing',
  'reviewing',
  'mr_ready',
  'blocked',
  'cancelled',
  'failed',
  'done',
] as const;

export type Stage = (typeof STAGES)[number];

export const TERMINAL_STAGES: ReadonlySet<Stage> = new Set<Stage>(['done', 'cancelled', 'failed']);

export function isTerminal(stage: Stage): boolean {
  return TERMINAL_STAGES.has(stage);
}

/** Why a run is `blocked`; a human (or a Jira reply) moves it back to `queued`. */
export const BLOCKED_REASONS = ['needs_clarification', 'iteration_cap', 'budget_exceeded'] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

const TRANSITIONS: Readonly<Record<Stage, readonly Stage[]>> = {
  // `queued → implementing|reviewing` resume a run that was blocked after
  // intake had already passed (iteration cap or budget); intake is not
  // repeated. `queued → blocked` is the budget check before the first spawn
  // after such a resume (decision 0015).
  queued: ['intake', 'implementing', 'reviewing', 'blocked', 'cancelled', 'failed'],
  intake: ['implementing', 'blocked', 'cancelled', 'failed'],
  implementing: ['reviewing', 'blocked', 'cancelled', 'failed'],
  reviewing: ['implementing', 'mr_ready', 'blocked', 'cancelled', 'failed'],
  mr_ready: ['done', 'cancelled', 'failed'],
  blocked: ['queued', 'cancelled', 'failed'],
  cancelled: [],
  failed: [],
  done: [],
};

export function canTransition(from: Stage, to: Stage): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: Stage,
    readonly to: Stage,
  ) {
    super(`illegal run transition ${from} → ${to}`);
  }
}

export function assertTransition(from: Stage, to: Stage): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
