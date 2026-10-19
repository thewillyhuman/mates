import { z } from 'zod';
import { MATES } from './events.js';

/**
 * The invocation context bundle (§7.2): what `mates-api` packs into a
 * tar.gz and `mates-run` extracts into `/context`. `invocation.json` is the
 * machine-readable part; the rest are files the mate reads.
 */
export const CONTEXT_FILES = {
  invocation: 'invocation.json',
  brief: 'brief.md',
  system: 'system.md',
  ticket: 'ticket.json',
  priorVerdicts: 'prior_verdicts.json',
  nudges: 'nudges.json',
  diff: 'diff.patch',
  testsLog: 'tests.log',
  verdictSchema: 'verdict.schema.json',
  intakeSchema: 'intake.schema.json',
  teamDir: 'team',
} as const;

export const PERMISSION_MODES = ['acceptEdits', 'dontAsk', 'default', 'plan'] as const;

export const invocationContextSchema = z.object({
  invocation_id: z.string().min(1),
  run_id: z.string().min(1),
  mate: z.enum(MATES),
  iteration: z.number().int().min(0),
  ticket: z.object({
    key: z.string().min(1),
    title: z.string(),
    url: z.string().nullable().default(null),
  }),
  /** Null for an intake pass that has no single candidate repository (§7.4). */
  repo: z
    .object({
      id: z.string().min(1),
      clone_url: z.string().min(1),
      default_branch: z.string().min(1),
      base_branch: z.string().min(1),
      /** The run branch; the runner refuses to push anywhere else (§10.5). */
      branch: z.string().min(1),
      setup: z.string().default(''),
      test: z.string().default(''),
      lint: z.string().default(''),
      env: z.record(z.string(), z.string()).default({}),
      paths_hint: z.array(z.string()).default([]),
    })
    .nullable(),
  git: z.object({
    /** Username for the credential helper; the token comes from GIT_TOKEN. */
    username: z.string().min(1),
    author_name: z.string().min(1).default('Mates'),
    author_email: z.string().min(1).default('mates@localhost'),
  }),
  claude: z.object({
    model: z.string().min(1),
    allowed_tools: z.array(z.string()),
    /** e.g. `Bash(git push *)` for the implementer (§7.3, §10.5). */
    disallowed_tools: z.array(z.string()).default([]),
    permission_mode: z.enum(PERMISSION_MODES),
    max_budget_usd: z.number().positive(),
    max_turns: z.number().int().positive(),
    timeout_seconds: z.number().int().positive(),
    /** File inside /context passed as --json-schema (reviewer, intake). */
    json_schema_file: z.string().nullable().default(null),
    effort: z.enum(['low', 'medium', 'high']).nullable().default(null),
  }),
  commit: z.object({
    trailer: z.string().default(''),
    default_summary: z.string().min(1),
  }),
  branching: z.object({ pattern: z.string().min(1) }),
  setup_timeout_seconds: z.number().int().positive().default(600),
  test_timeout_seconds: z.number().int().positive().default(1200),
  /** Present only in fake-Claude mode (§15.1). */
  fake: z
    .object({ scenario: z.string().min(1), patch: z.string().nullable().default(null) })
    .nullable()
    .default(null),
});
export type InvocationContext = z.infer<typeof invocationContextSchema>;
