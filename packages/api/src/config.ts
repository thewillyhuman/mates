import { z } from 'zod';

/**
 * Process configuration (§5.2: Helm values → environment → DB settings).
 *
 * This module covers the environment layer only: everything the process
 * needs before it can reach the database. Validated once at start-up; an
 * invalid environment fails the process with a readable message.
 */

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** Helm release name; Kubernetes Secrets are named `<release>-credentials` etc. (§10.2). */
  MATES_RELEASE: z.string().min(1).default('mates'),
  MATES_NAMESPACE: z.string().min(1).default('mates'),
  /** Base URL humans use to reach the UI; used in Jira comments and MR descriptions. */
  MATES_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  /** HS256 key for per-invocation JWTs and session cookies (`<release>-internal`). */
  MATES_INTERNAL_KEY: z.string().min(32, 'MATES_INTERNAL_KEY must be at least 32 characters'),
  /** Where credentials live. Defaults to Kubernetes when running in a pod. */
  MATES_SECRET_STORE: z.enum(['kubernetes', 'memory']).optional(),
  /** Set by the kubelet in every pod; used to detect in-cluster execution. */
  KUBERNETES_SERVICE_HOST: z.string().optional(),
  /** Directory of the built UI. Served at `/` when present. */
  MATES_UI_DIR: z.string().optional(),
  /** Helm-managed settings file (chart ConfigMap); read by the settings layer. */
  MATES_CONFIG_FILE: z.string().optional(),
  /** URL runner pods use to reach this API; defaults to the public URL. */
  MATES_INTERNAL_URL: z.string().url().optional(),
  /** `1` replays fixtures instead of calling Claude in runner pods (§15.1). */
  MATES_FAKE_CLAUDE: z.string().optional(),
  /** Runner image when neither settings nor mates.yaml name one. */
  MATES_RUNNER_IMAGE: z.string().default('ghcr.io/thewillyhuman/mates-runner:latest'),
  /** `kubernetes` spawns real Jobs; `fake` keeps them in memory (local development). */
  MATES_JOBS: z.enum(['kubernetes', 'fake']).optional(),
});

export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly host: string;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  readonly release: string;
  readonly namespace: string;
  readonly publicUrl: string;
  readonly internalKey: string;
  readonly secretStore: 'kubernetes' | 'memory';
  readonly inCluster: boolean;
  readonly uiDir: string | undefined;
  readonly configFile: string | undefined;
  readonly internalUrl: string;
  readonly fakeClaude: boolean;
  readonly runnerImage: string;
  readonly jobs: 'kubernetes' | 'fake';
}

/** Parses and validates the environment. Throws with the offending variable names. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  const inCluster = e.KUBERNETES_SERVICE_HOST !== undefined;
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    release: e.MATES_RELEASE,
    namespace: e.MATES_NAMESPACE,
    publicUrl: e.MATES_PUBLIC_URL.replace(/\/+$/, ''),
    internalKey: e.MATES_INTERNAL_KEY,
    secretStore: e.MATES_SECRET_STORE ?? (inCluster ? 'kubernetes' : 'memory'),
    inCluster,
    uiDir: e.MATES_UI_DIR,
    configFile: e.MATES_CONFIG_FILE,
    internalUrl: (e.MATES_INTERNAL_URL ?? e.MATES_PUBLIC_URL).replace(/\/+$/, ''),
    fakeClaude: e.MATES_FAKE_CLAUDE === '1',
    runnerImage: e.MATES_RUNNER_IMAGE,
    jobs: e.MATES_JOBS ?? (inCluster ? 'kubernetes' : 'fake'),
  };
}
