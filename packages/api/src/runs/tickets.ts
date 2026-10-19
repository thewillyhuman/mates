import type { Stage } from '@mates/core';
import type { Queryable } from '../db/pool.js';
import type { TicketDetails } from '../tracker/types.js';

/** Tickets with their latest run (§13.3): the Tickets table and its CSV export. */
export interface TicketRow {
  id: string;
  key: string;
  title: string;
  url: string | null;
  projectKey: string | null;
  repoId: string | null;
  createdAt: Date;
  runs: number;
  latestRun: {
    id: string;
    stage: Stage;
    iteration: number;
    maxIterations: number;
    costUsd: number;
    mrUrl: string | null;
    mrState: string | null;
    createdAt: Date;
    finishedAt: Date | null;
  } | null;
}

export interface TicketFilter {
  project?: string | undefined;
  repo?: string | undefined;
  stage?: Stage | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

interface Row {
  id: string;
  external_key: string;
  title: string;
  url: string | null;
  project_key: string | null;
  repo_id: string | null;
  created_at: Date;
  runs: string;
  run_id: string | null;
  status: Stage | null;
  iteration: number | null;
  max_iterations: number | null;
  cost_usd: string | null;
  mr_url: string | null;
  mr_state: string | null;
  run_created_at: Date | null;
  finished_at: Date | null;
}

function toRow(r: Row): TicketRow {
  return {
    id: r.id,
    key: r.external_key,
    title: r.title,
    url: r.url,
    projectKey: r.project_key,
    repoId: r.repo_id,
    createdAt: r.created_at,
    runs: Number(r.runs),
    latestRun: r.run_id
      ? {
          id: r.run_id,
          stage: r.status!,
          iteration: r.iteration ?? 0,
          maxIterations: r.max_iterations ?? 0,
          costUsd: Number(r.cost_usd ?? 0),
          mrUrl: r.mr_url,
          mrState: r.mr_state,
          createdAt: r.run_created_at!,
          finishedAt: r.finished_at,
        }
      : null,
  };
}

export async function listTickets(db: Queryable, f: TicketFilter = {}): Promise<TicketRow[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    conds.push(sql.replace('?', `$${params.length}`));
  };
  if (f.project) add('t.project_key = ?', f.project);
  if (f.repo) add('t.repo_id = ?', f.repo);
  if (f.stage) add('lr.status = ?', f.stage);
  if (f.from) add('t.created_at >= ?', f.from);
  if (f.to) add('t.created_at < ?', f.to);
  if (f.q)
    add('(t.external_key ILIKE ? OR t.title ILIKE $' + (params.length + 1) + ')', `%${f.q}%`);
  if (f.cursor) add('t.created_at < (SELECT created_at FROM tickets WHERE id = ?)', f.cursor);
  params.push(f.limit ?? 200);
  const r = await db.query<Row>(
    `SELECT t.id, t.external_key, t.title, t.url, t.project_key, t.repo_id, t.created_at,
            (SELECT count(*) FROM runs WHERE ticket_id = t.id)::text AS runs,
            lr.id AS run_id, lr.status, lr.iteration, lr.max_iterations, lr.mr_url, lr.mr_state,
            lr.created_at AS run_created_at, lr.finished_at,
            (SELECT COALESCE(sum(cost_usd_reported), 0) FROM usage WHERE run_id = lr.id)::text AS cost_usd
     FROM tickets t
     LEFT JOIN LATERAL (SELECT * FROM runs WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1) lr ON true
     ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
     ORDER BY t.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map(toRow);
}

/** CSV with a header row; values are quoted when needed. */
export function ticketsToCsv(rows: TicketRow[]): string {
  const cell = (v: string | number | Date | null | undefined): string => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    'key',
    'title',
    'project',
    'repo',
    'runs',
    'latest_stage',
    'iterations',
    'cost_usd',
    'mr_url',
    'mr_state',
    'created_at',
    'finished_at',
  ];
  const lines = rows.map((t) =>
    [
      t.key,
      t.title,
      t.projectKey,
      t.repoId,
      t.runs,
      t.latestRun?.stage,
      t.latestRun ? `${t.latestRun.iteration}/${t.latestRun.maxIterations}` : '',
      t.latestRun?.costUsd.toFixed(4),
      t.latestRun?.mrUrl,
      t.latestRun?.mrState,
      t.latestRun?.createdAt,
      t.latestRun?.finishedAt,
    ]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}

export type { TicketDetails };
