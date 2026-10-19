import { z } from 'zod';

/** Environment the Job spec gives `mates-run` (§7.2). Fails fast on anything missing. */
const schema = z.object({
  MATES_API_URL: z.string().url(),
  MATES_INVOCATION_TOKEN: z.string().min(1),
  MATES_INVOCATION_ID: z.string().min(1),
  MATES_RUN_ID: z.string().min(1),
  MATES_MATE: z.enum(['intake', 'implementer', 'reviewer']),
  MATES_ITERATION: z.coerce.number().int().min(0),
  /** `1` makes the runner replay a fixture instead of calling `claude` (§15.1). */
  MATES_FAKE_CLAUDE: z.string().optional(),
  /** Git credential; never logged, never in a URL (§10.2). */
  GIT_TOKEN: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  MATES_WORKSPACE: z.string().default('/workspace'),
  MATES_CONTEXT_DIR: z.string().default('/context'),
  MATES_FIXTURES_DIR: z.string().default('/usr/local/share/mates/fixtures/claude'),
});

export type Mate = 'intake' | 'implementer' | 'reviewer';

export interface RunnerEnv {
  readonly apiUrl: string;
  readonly token: string;
  readonly invocationId: string;
  readonly runId: string;
  readonly mate: Mate;
  readonly iteration: number;
  readonly fakeClaude: boolean;
  readonly gitToken: string | undefined;
  readonly anthropicApiKey: string | undefined;
  readonly workspace: string;
  readonly contextDir: string;
  readonly fixturesDir: string;
  /** Values that must never appear in events, blobs or logs. */
  readonly secrets: readonly string[];
}

export function parseRunnerEnv(env: NodeJS.ProcessEnv): RunnerEnv {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`mates-run: invalid environment: ${problems}`);
  }
  const e = parsed.data;
  return {
    apiUrl: e.MATES_API_URL.replace(/\/+$/, ''),
    token: e.MATES_INVOCATION_TOKEN,
    invocationId: e.MATES_INVOCATION_ID,
    runId: e.MATES_RUN_ID,
    mate: e.MATES_MATE,
    iteration: e.MATES_ITERATION,
    fakeClaude: e.MATES_FAKE_CLAUDE === '1',
    gitToken: e.GIT_TOKEN,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    workspace: e.MATES_WORKSPACE,
    contextDir: e.MATES_CONTEXT_DIR,
    fixturesDir: e.MATES_FIXTURES_DIR,
    secrets: [e.GIT_TOKEN, e.ANTHROPIC_API_KEY, e.MATES_INVOCATION_TOKEN].filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    ),
  };
}
