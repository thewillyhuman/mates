import type { Pool } from '../db/pool.js';

/**
 * Rollups of §9.2, computed on the fly over `usage`, `runs` and `events`.
 * Volumes are small (one row per invocation), so no materialised views.
 */
export const GROUP_BY = [
  'day',
  'week',
  'month',
  'mate',
  'model',
  'run',
  'ticket',
  'repo',
  'project',
] as const;
export type GroupBy = (typeof GROUP_BY)[number];

export interface UsageBucket {
  key: string;
  cost_usd: number;
  cost_usd_computed: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  invocations: number;
}

export interface Outcomes {
  runs_done: number;
  runs_failed: number;
  runs_blocked: number;
  runs_cancelled: number;
  /** Average cost of runs that reached `done`; null without any. */
  cost_per_done_mr: number | null;
  iterations_to_approval: { iterations: number; count: number }[];
  duration_p50_ms: number | null;
  duration_p90_ms: number | null;
}

export interface BoardStats {
  running: { total: number; by_stage: Record<string, number> };
  waiting: { total: number; by_reason: Record<string, number> };
  mrs_opened_today: { total: number; ready: number; draft: number };
  iterations_to_approval_7d: { average: number | null; cap: number };
  spend_today: { tokens: number; usd: number; per_ticket_tokens: number | null; runs: number };
  daily_budget: { limit: number; spent: number; exceeded: boolean; resets_at: string };
}

const groupExpr: Record<GroupBy, string> = {
  day: "to_char(date_trunc('day', u.ts AT TIME ZONE $3), 'YYYY-MM-DD')",
  week: "to_char(date_trunc('week', u.ts AT TIME ZONE $3), 'IYYY-\"W\"IW')",
  month: "to_char(date_trunc('month', u.ts AT TIME ZONE $3), 'YYYY-MM')",
  mate: 'i.mate',
  model: 'u.model',
  run: 'u.run_id::text',
  ticket: 't.external_key',
  repo: "COALESCE(t.repo_id, '(none)')",
  project: "COALESCE(t.project_key, '(none)')",
};

export class StatsService {
  constructor(private readonly db: Pool) {}

  async usage(from: Date, to: Date, groupBy: GroupBy, timezone = 'UTC'): Promise<UsageBucket[]> {
    const expr = groupExpr[groupBy];
    const r = await this.db.query<{
      key: string;
      cost_usd: string;
      cost_usd_computed: string | null;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      invocations: string;
    }>(
      `SELECT ${expr} AS key,
              COALESCE(sum(u.cost_usd_reported), 0)::text AS cost_usd,
              CASE WHEN bool_and(u.cost_usd_computed IS NOT NULL) THEN sum(u.cost_usd_computed)::text ELSE NULL END AS cost_usd_computed,
              sum(u.input_tokens)::text AS input_tokens, sum(u.output_tokens)::text AS output_tokens,
              sum(u.cache_read_tokens)::text AS cache_read_tokens, sum(u.cache_write_tokens)::text AS cache_write_tokens,
              count(DISTINCT u.invocation_id)::text AS invocations
       FROM usage u
       JOIN invocations i ON i.id = u.invocation_id
       JOIN runs r ON r.id = u.run_id
       JOIN tickets t ON t.id = r.ticket_id
       WHERE u.ts >= $1 AND u.ts < $2
       GROUP BY 1 ORDER BY 1`,
      expr.includes('$3') ? [from, to, timezone] : [from, to],
    );
    return r.rows.map((row) => ({
      key: row.key,
      cost_usd: Number(row.cost_usd),
      cost_usd_computed: row.cost_usd_computed === null ? null : Number(row.cost_usd_computed),
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      cache_read_tokens: Number(row.cache_read_tokens),
      cache_write_tokens: Number(row.cache_write_tokens),
      invocations: Number(row.invocations),
    }));
  }

  async outcomes(from: Date, to: Date): Promise<Outcomes> {
    const counts = await this.db.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM runs WHERE created_at >= $1 AND created_at < $2 GROUP BY status`,
      [from, to],
    );
    const by = Object.fromEntries(counts.rows.map((r) => [r.status, Number(r.n)]));
    const cost = await this.db.query<{ avg: string | null }>(
      `SELECT avg(c.cost)::text AS avg FROM (
         SELECT r.id, COALESCE(sum(u.cost_usd_reported), 0) AS cost
         FROM runs r LEFT JOIN usage u ON u.run_id = r.id
         WHERE r.status = 'done' AND r.created_at >= $1 AND r.created_at < $2 GROUP BY r.id) c`,
      [from, to],
    );
    const hist = await this.db.query<{ iteration: number; n: string }>(
      `SELECT iteration, count(*)::text AS n FROM runs WHERE status = 'done' AND created_at >= $1 AND created_at < $2
       GROUP BY iteration ORDER BY iteration`,
      [from, to],
    );
    const dur = await this.db.query<{ p50: string | null; p90: string | null }>(
      `SELECT (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - created_at)) * 1000)::text AS p50,
              (percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - created_at)) * 1000)::text AS p90
       FROM runs WHERE finished_at IS NOT NULL AND created_at >= $1 AND created_at < $2`,
      [from, to],
    );
    return {
      runs_done: by.done ?? 0,
      runs_failed: by.failed ?? 0,
      runs_blocked: by.blocked ?? 0,
      runs_cancelled: by.cancelled ?? 0,
      cost_per_done_mr:
        cost.rows[0]?.avg === null || cost.rows[0]?.avg === undefined
          ? null
          : Number(cost.rows[0].avg),
      iterations_to_approval: hist.rows.map((r) => ({
        iterations: r.iteration,
        count: Number(r.n),
      })),
      duration_p50_ms: dur.rows[0]?.p50 ? Math.round(Number(dur.rows[0].p50)) : null,
      duration_p90_ms: dur.rows[0]?.p90 ? Math.round(Number(dur.rows[0].p90)) : null,
    };
  }

  /** The board's stats strip and the daily-budget banner (§13.1, §9.4). */
  async board(timezone: string, perDayUsd: number, maxIterations: number): Promise<BoardStats> {
    const running = await this.db.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM runs WHERE status IN ('intake', 'implementing', 'reviewing') GROUP BY status`,
    );
    const blocked = await this.db.query<{ reason: string; n: string }>(
      `SELECT COALESCE(e.payload->>'reason', 'unknown') AS reason, count(*)::text AS n
       FROM runs r
       JOIN LATERAL (SELECT payload FROM events WHERE run_id = r.id AND type = 'run.stage_changed' ORDER BY id DESC LIMIT 1) e ON true
       WHERE r.status = 'blocked' GROUP BY 1`,
    );
    const mrs = await this.db.query<{ total: string; ready: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE r.mr_state = 'ready')::text AS ready
       FROM events e JOIN runs r ON r.id = e.run_id
       WHERE e.type = 'mr.opened' AND e.ts >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`,
      [timezone],
    );
    const iters = await this.db.query<{ avg: string | null }>(
      `SELECT avg(iteration)::text AS avg FROM runs WHERE status = 'done' AND finished_at >= now() - interval '7 days'`,
    );
    const spend = await this.db.query<{ tokens: string; usd: string; runs: string }>(
      `SELECT COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::text AS tokens,
              COALESCE(sum(cost_usd_reported), 0)::text AS usd,
              count(DISTINCT run_id)::text AS runs
       FROM usage WHERE ts >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)`,
      [timezone],
    );
    const reset = await this.db.query<{ at: Date }>(
      `SELECT ((date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1) AS at`,
      [timezone],
    );
    const byStage = Object.fromEntries(running.rows.map((r) => [r.status, Number(r.n)]));
    const byReason = Object.fromEntries(blocked.rows.map((r) => [r.reason, Number(r.n)]));
    const tokens = Number(spend.rows[0]?.tokens ?? 0);
    const runs = Number(spend.rows[0]?.runs ?? 0);
    const usd = Number(spend.rows[0]?.usd ?? 0);
    const total = Number(mrs.rows[0]?.total ?? 0);
    const ready = Number(mrs.rows[0]?.ready ?? 0);
    return {
      running: { total: Object.values(byStage).reduce((a, b) => a + b, 0), by_stage: byStage },
      waiting: { total: Object.values(byReason).reduce((a, b) => a + b, 0), by_reason: byReason },
      mrs_opened_today: { total, ready, draft: total - ready },
      iterations_to_approval_7d: {
        average: iters.rows[0]?.avg ? Math.round(Number(iters.rows[0].avg) * 10) / 10 : null,
        cap: maxIterations,
      },
      spend_today: {
        tokens,
        usd,
        per_ticket_tokens: runs ? Math.round(tokens / runs) : null,
        runs,
      },
      daily_budget: {
        limit: perDayUsd,
        spent: usd,
        exceeded: usd >= perDayUsd,
        resets_at: reset.rows[0]!.at.toISOString(),
      },
    };
  }
}
