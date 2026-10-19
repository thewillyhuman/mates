import { z } from 'zod';

/**
 * Non-secret settings (§6.2), one zod section per wizard step. Every field
 * has a default so `settingsSchema.parse({})` is a valid configuration;
 * the UI's "Test" buttons tell the operator what is still missing.
 */
const mateSchema = (model: string, budget: number, turns: number, timeout: number) =>
  z.object({
    model: z.string().min(1).default(model),
    effort: z.enum(['low', 'medium', 'high']).nullable().default(null),
    max_budget_usd: z.number().positive().default(budget),
    max_turns: z.number().int().positive().default(turns),
    timeout_seconds: z.number().int().positive().default(timeout),
  });

const resourcesSchema = z.object({
  requests: z
    .object({ cpu: z.string().default('1'), memory: z.string().default('2Gi') })
    .prefault({}),
  limits: z
    .object({ cpu: z.string().default('4'), memory: z.string().default('8Gi') })
    .prefault({}),
});

export const providerSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  type: z.enum(['gitlab', 'github', 'gitea']),
  base_url: z.string().url(),
  /** Credential username for generic hosts (Gitea); GitLab/GitHub have fixed ones. */
  username: z.string().default(''),
  draft_mrs: z.boolean().default(true),
  labels: z.array(z.string()).default([]),
  reviewers: z.array(z.string()).default([]),
});
export type ScmProvider = z.infer<typeof providerSchema>;

export const priceSchema = z.object({
  input_per_mtok: z.number().min(0),
  output_per_mtok: z.number().min(0),
  cache_read_per_mtok: z.number().min(0),
  cache_write_per_mtok: z.number().min(0),
  currency: z.literal('USD').default('USD'),
});
export type Price = z.infer<typeof priceSchema>;

export const settingsSchema = z.object({
  anthropic: z
    .object({ provider: z.enum(['api_key', 'bedrock', 'vertex', 'foundry']).default('api_key') })
    .prefault({}),
  jira: z
    .object({
      base_url: z.string().default(''),
      auth: z.enum(['cloud', 'datacenter']).default('cloud'),
      email: z.string().default(''),
      trigger: z
        .object({
          kind: z.enum(['assignee', 'label', 'status', 'jql']).default('assignee'),
          value: z.string().default(''),
        })
        .prefault({}),
      status_map: z
        .object({
          intake: z.string().default(''),
          in_progress: z.string().default(''),
          mr_ready: z.string().default(''),
          blocked: z.string().default(''),
        })
        .prefault({}),
      comments: z
        .object({
          clarification: z.boolean().default(true),
          status: z.boolean().default(true),
          cost: z.boolean().default(true),
        })
        .prefault({}),
      comment_prefix: z.string().default('🤖 Mates:'),
      poll_interval_seconds: z.number().int().min(10).default(60),
      webhook_secret_in: z.enum(['header', 'query']).default('header'),
    })
    .prefault({}),
  scm: z.object({ providers: z.array(providerSchema).default([]) }).prefault({}),
  team_context: z
    .object({
      source: z.enum(['upload', 'git']).default('upload'),
      git_url: z.string().default(''),
      git_ref: z.string().default('main'),
    })
    .prefault({}),
  mates: z
    .object({
      intake: mateSchema('claude-sonnet-5-5', 2, 30, 600).prefault({}),
      implementer: mateSchema('claude-opus-5-5', 10, 200, 2700).prefault({}),
      reviewer: mateSchema('claude-opus-5-5', 5, 60, 1800).prefault({}),
    })
    .prefault({}),
  limits: z
    .object({
      max_iterations: z.number().int().min(1).max(10).default(4),
      per_run_usd: z.number().positive().default(25),
      per_day_usd: z.number().positive().default(200),
      per_project_daily_usd: z.record(z.string(), z.number().positive()).prefault({}),
      timezone: z.string().default('UTC'),
    })
    .prefault({}),
  runner: z
    .object({
      image: z.string().default(''),
      resources: resourcesSchema.prefault({}),
      timeout_seconds: z.number().int().positive().default(2700),
      workspace_size_gi: z.number().positive().default(10),
      ca_bundle_configmap: z.string().default(''),
      http_proxy: z.string().default(''),
      no_proxy: z.string().default(''),
      image_pull_secret: z.string().default(''),
    })
    .prefault({}),
  notifications: z.object({ webhook_url: z.string().default('') }).prefault({}),
  pricing: z.record(z.string(), priceSchema).prefault({}),
  prompts: z.record(z.string(), z.string()).prefault({}),
  retention: z
    .object({
      transcripts_days: z.number().int().min(1).default(14),
      events_days: z.number().int().min(1).default(365),
    })
    .prefault({}),
  /** Only honoured when the API runs with MATES_FAKE_CLAUDE=1 (§15.1). */
  fake_claude: z
    .object({
      scenarios: z
        .object({
          intake: z.array(z.string()).default(['intake_implementable']),
          implementer: z.array(z.string()).default(['impl_iter1_green']),
          reviewer: z.array(z.string()).default(['review_approve']),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = keyof Settings;
export const SETTINGS_SECTIONS = Object.keys(settingsSchema.shape) as SettingsSection[];
