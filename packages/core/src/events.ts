import { z } from 'zod';
import { STAGES } from './stage.js';

/**
 * Event types of §4.3, each with a zod schema for its payload. The schemas
 * validate what runners send to the ingest endpoint and what the
 * orchestrator appends; the TypeScript types are derived from them so
 * there is exactly one definition per event.
 *
 * Additions to the spec's list: `run.paused` / `run.resumed` (§7.5 rule 8)
 * and `run.created.max_iterations` so the projection knows the cap.
 */
export const MATES = ['intake', 'implementer', 'reviewer'] as const;
export type Mate = (typeof MATES)[number];

const mate = z.enum(MATES);
const stage = z.enum(STAGES);

export const reviewItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().default(''),
  file: z.string().nullable().default(null),
  line: z.number().int().nullable().default(null),
});
export type ReviewItem = z.infer<typeof reviewItemSchema>;

const tokens = z.number().int().min(0).default(0);

/** The `result` message Claude Code prints last in stream-json (§7.3), fields we rely on. */
export const claudeResultSchema = z.looseObject({
  type: z.literal('result').optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  session_id: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  num_turns: z.number().int().optional(),
  duration_ms: z.number().optional(),
  usage: z
    .looseObject({
      input_tokens: z.number().int().optional(),
      output_tokens: z.number().int().optional(),
      cache_read_input_tokens: z.number().int().optional(),
      cache_creation_input_tokens: z.number().int().optional(),
    })
    .optional(),
  modelUsage: z
    .record(
      z.string(),
      z.looseObject({
        inputTokens: z.number().int().optional(),
        outputTokens: z.number().int().optional(),
        cacheReadInputTokens: z.number().int().optional(),
        cacheCreationInputTokens: z.number().int().optional(),
        costUSD: z.number().optional(),
      }),
    )
    .optional(),
  permission_denials: z.array(z.unknown()).optional(),
});
export type ClaudeResult = z.infer<typeof claudeResultSchema>;

export const eventPayloadSchemas = {
  'run.created': z.object({
    ticket_key: z.string().min(1),
    trigger: z.enum(['webhook', 'poll', 'manual']),
    by: z.string().min(1),
    max_iterations: z.number().int().min(1).max(10),
    budget_usd: z.number().nullable().default(null),
  }),
  'run.stage_changed': z.object({ from: stage, to: stage, reason: z.string() }),
  'run.cancelled': z.object({ by: z.string(), reason: z.string().default('') }),
  'run.failed': z.object({ reason: z.string(), detail: z.string().default('') }),
  'run.budget_exceeded': z.object({
    kind: z.enum(['usd', 'tokens']),
    limit: z.number(),
    used: z.number(),
  }),
  'run.paused': z.object({ by: z.string() }),
  'run.resumed': z.object({ by: z.string() }),

  'intake.started': z.object({}),
  'intake.finished': z.object({}),
  'intake.needs_clarification': z.object({
    questions: z.array(z.string()),
    tracker_comment_id: z.string().nullable().default(null),
  }),
  'intake.passed': z.object({
    repo: z.string().min(1),
    base_branch: z.string().min(1),
    plan: z.array(z.string()),
    scope_notes: z.string().default(''),
  }),

  'invocation.scheduled': z.object({
    mate,
    iteration: z.number().int().min(0),
    job_name: z.string(),
    model: z.string(),
  }),
  'invocation.started': z.object({ pod_name: z.string().default('') }),
  'invocation.heartbeat': z.object({
    note: z.string().optional(),
    /** Cumulative tokens seen in assistant messages so far; a live estimate (§9.1). */
    usage: z
      .object({
        input_tokens: tokens,
        output_tokens: tokens,
        cache_read_tokens: tokens,
        cache_write_tokens: tokens,
      })
      .optional(),
  }),
  'invocation.tool_use': z.object({ tool: z.string(), summary: z.string().max(500) }),
  'invocation.text': z.object({ text: z.string().max(2000) }),
  'invocation.finished': z.object({
    exit_code: z.number().int(),
    duration_ms: z.number().int().min(0),
    session_id: z.string().nullable().default(null),
    result: claudeResultSchema.nullable().default(null),
    /** Blob id of the gzipped stream-json transcript (§7.3 step 7). */
    transcript_ref: z.string().nullable().default(null),
  }),
  'invocation.failed': z.object({ reason: z.string(), detail: z.string().default('') }),

  'implementation.pushed': z.object({
    commit: z.string(),
    /** Diff of the run branch against the base branch (§7.3 step 6). */
    files_changed: z.number().int().min(0),
    additions: z.number().int().min(0),
    deletions: z.number().int().min(0),
    /** `false` when this iteration produced no new commit (§7.5 rule 5). */
    changed_in_iteration: z.boolean().default(true),
    /** Blob id of the full diff against the base branch. */
    diff_ref: z.string().nullable().default(null),
  }),
  'implementation.tests': z.object({
    passed: z.number().int().nullable(),
    failed: z.number().int().nullable(),
    skipped: z.number().int().nullable(),
    runner: z.string().nullable(),
    duration_ms: z.number().int().nullable(),
    log_ref: z.string().nullable(),
  }),
  'implementation.addressed': z.object({
    blocking_ids: z.array(z.string()),
    skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
    summary: z.string().default(''),
  }),

  'review.verdict': z.object({
    decision: z.enum(['approve', 'changes_requested']),
    blocking: z.array(reviewItemSchema),
    non_blocking: z.array(reviewItemSchema),
    summary: z.string(),
  }),

  'mr.opened': z.object({ mr_id: z.string(), url: z.string(), draft: z.boolean() }),
  'mr.updated': z.object({ description_updated: z.boolean() }),
  'mr.marked_ready': z.object({ mr_id: z.string() }),
  'tracker.transitioned': z.object({ from: z.string(), to: z.string() }),
  'tracker.commented': z.object({
    comment_id: z.string(),
    kind: z.enum(['clarification', 'status', 'nudge_echo']),
  }),

  'nudge.added': z.object({ nudge_id: z.string(), by: z.string(), text: z.string() }),
  'nudge.consumed': z.object({ nudge_id: z.string(), invocation_id: z.string() }),

  'usage.recorded': z.object({
    model: z.string(),
    input_tokens: tokens,
    output_tokens: tokens,
    cache_read_tokens: tokens,
    cache_write_tokens: tokens,
    cost_usd: z.number().nullable().default(null),
  }),
} as const;

export type EventType = keyof typeof eventPayloadSchemas;
export const EVENT_TYPES = Object.keys(eventPayloadSchemas) as readonly EventType[];

export type EventPayload<T extends EventType> = z.infer<(typeof eventPayloadSchemas)[T]>;

/** A persisted event. `ts` is ISO-8601; `id` is the append order. */
export type RunEvent = {
  [K in EventType]: {
    id: number;
    run_id: string;
    invocation_id: string | null;
    ts: string;
    type: K;
    payload: EventPayload<K>;
  };
}[EventType];

/** An event about to be appended; `ts` defaults to now on insert. */
export type NewEvent = {
  [K in EventType]: {
    type: K;
    payload: EventPayload<K>;
    invocation_id?: string | null;
    ts?: string;
  };
}[EventType];

/** Event types a runner may emit (§7.3). Everything else is orchestrator-only. */
export const RUNNER_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'invocation.started',
  'invocation.heartbeat',
  'invocation.tool_use',
  'invocation.text',
  'invocation.finished',
  'invocation.failed',
  'implementation.pushed',
  'implementation.tests',
  'implementation.addressed',
]);

const envelopeSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
  ts: z.string().datetime({ offset: true }).optional(),
});

export class EventValidationError extends Error {}

/** Validates an untrusted `{ type, payload, ts? }` into a typed `NewEvent`. */
export function parseEvent(input: unknown): NewEvent {
  const env = envelopeSchema.safeParse(input);
  if (!env.success) throw new EventValidationError('event must be { type, payload, ts? }');
  const type = env.data.type as EventType;
  const schema = (eventPayloadSchemas as Record<string, z.ZodType>)[type];
  if (!schema) throw new EventValidationError(`unknown event type ${env.data.type}`);
  const payload = schema.safeParse(env.data.payload ?? {});
  if (!payload.success) {
    const why = payload.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new EventValidationError(`invalid payload for ${type}: ${why}`);
  }
  const event = { type, payload: payload.data } as NewEvent;
  if (env.data.ts) event.ts = env.data.ts;
  return event;
}

/** Typed constructor for orchestrator code. */
export function event<T extends EventType>(
  type: T,
  payload: EventPayload<T>,
  invocationId?: string | null,
): NewEvent {
  return { type, payload, invocation_id: invocationId ?? null } as NewEvent;
}
