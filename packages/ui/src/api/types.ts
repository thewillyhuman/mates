import type { RunProjection, Stage } from '@mates/core';
import type { components, paths } from './schema.js';

/**
 * Response types the pages use, derived from the generated OpenAPI schema
 * (§12). The run projection is typed through @mates/core: the API serves
 * it as-is from projectRun.
 */
type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never;
type Ok<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { 200: infer R };
}
  ? Json<R>
  : never;

export type RunSummary = Ok<'/api/runs', 'get'>['runs'][number];
export type RunDetail = Omit<Ok<'/api/runs/{id}', 'get'>, 'projection'> & {
  projection: RunProjection;
};
export type RunEvent = Ok<'/api/runs/{id}/events', 'get'>['events'][number];
export type TicketRow = Ok<'/api/tickets', 'get'>['tickets'][number];
export type TicketDetail = Ok<'/api/tickets/{key}', 'get'>;
export type BoardStats = {
  running: { total: number; by_stage: Record<string, number> };
  waiting: { total: number; by_reason: Record<string, number> };
  mrs_opened_today: { total: number; ready: number; draft: number };
  iterations_to_approval_7d: { average: number | null; cap: number };
  spend_today: { tokens: number; usd: number; per_ticket_tokens: number | null; runs: number };
  daily_budget: { limit: number; spent: number; exceeded: boolean; resets_at: string };
};
export type UsageBucket = Ok<'/api/stats', 'get'>['buckets'][number];
export type Outcomes = {
  runs_done: number;
  runs_failed: number;
  runs_blocked: number;
  runs_cancelled: number;
  cost_per_done_mr: number | null;
  iterations_to_approval: { iterations: number; count: number }[];
  duration_p50_ms: number | null;
  duration_p90_ms: number | null;
};
export type CredentialStatus = Ok<'/api/settings/credentials/{name}', 'get'>;
export type TeamContextVersion = Ok<'/api/settings/team-context', 'get'>['versions'][number];
export type PromptView = Ok<'/api/settings/prompts/{mate}', 'get'>;
export type ApiTokenView = Ok<'/api/api-tokens', 'get'>['tokens'][number];
export type UserView = components['schemas'] extends never
  ? never
  : Ok<'/api/users', 'get'>['users'][number];

export interface Settings {
  anthropic: { provider: 'api_key' | 'bedrock' | 'vertex' | 'foundry' };
  jira: {
    base_url: string;
    auth: 'cloud' | 'datacenter';
    email: string;
    trigger: { kind: 'assignee' | 'label' | 'status' | 'jql'; value: string };
    status_map: { intake: string; in_progress: string; mr_ready: string; blocked: string };
    comments: { clarification: boolean; status: boolean; cost: boolean };
    comment_prefix: string;
    poll_interval_seconds: number;
    webhook_secret_in: 'header' | 'query';
  };
  scm: {
    providers: {
      id: string;
      type: 'gitlab' | 'github' | 'gitea';
      base_url: string;
      username: string;
      draft_mrs: boolean;
      labels: string[];
      reviewers: string[];
    }[];
  };
  team_context: {
    source: 'upload' | 'git';
    git_provider: string;
    git_project: string;
    git_ref: string;
  };
  mates: Record<
    'intake' | 'implementer' | 'reviewer',
    {
      model: string;
      effort: 'low' | 'medium' | 'high' | null;
      max_budget_usd: number;
      max_turns: number;
      timeout_seconds: number;
    }
  >;
  limits: {
    max_iterations: number;
    per_run_usd: number;
    per_day_usd: number;
    per_project_daily_usd: Record<string, number>;
    timezone: string;
  };
  runner: {
    image: string;
    resources: {
      requests: { cpu: string; memory: string };
      limits: { cpu: string; memory: string };
    };
    timeout_seconds: number;
    workspace_size_gi: number;
    ca_bundle_configmap: string;
    http_proxy: string;
    no_proxy: string;
    image_pull_secret: string;
  };
  notifications: { webhook_url: string };
  pricing: Record<
    string,
    {
      input_per_mtok: number;
      output_per_mtok: number;
      cache_read_per_mtok: number;
      cache_write_per_mtok: number;
      currency: 'USD';
    }
  >;
  prompts: Record<string, string>;
  retention: { transcripts_days: number; events_days: number };
  fake_claude: { scenarios: Record<'intake' | 'implementer' | 'reviewer', string[]> };
}

export interface SettingsResponse {
  settings: Settings;
  managed: string[];
  ignored?: string[];
}

export type { Stage, RunProjection };

/** One row of the audit log (§10.5). */
export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
}
