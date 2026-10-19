import { TERMINAL_STAGES, type BlockedReason, type RunProjection, type Stage } from '@mates/core';
import type pg from 'pg';
import { withTransaction, type Pool, type Queryable } from '../db/pool.js';
import type { EventBus } from './bus.js';
import type { TicketDetails } from '../tracker/types.js';
import { appendEventsTx, listEvents, projectRunById } from './events.js';

/** Runs and tickets: creation, lookup and board listing. */

export interface Ticket {
  id: string;
  tracker: string;
  externalKey: string;
  externalId: string | null;
  title: string;
  url: string | null;
  projectKey: string | null;
  repoId: string | null;
  details: TicketDetails;
}

export interface Run {
  id: string;
  ticketId: string;
  status: Stage;
  iteration: number;
  maxIterations: number;
  branch: string | null;
  baseBranch: string | null;
  mrId: string | null;
  mrUrl: string | null;
  mrState: 'draft' | 'ready' | 'merged' | 'closed' | null;
  createdBy: string;
  createdAt: Date;
  finishedAt: Date | null;
  budgetUsd: number | null;
  teamContextVersion: number | null;
  paused: boolean;
}

interface TicketRow {
  id: string;
  tracker: string;
  external_key: string;
  external_id: string | null;
  title: string;
  url: string | null;
  project_key: string | null;
  repo_id: string | null;
  details: TicketDetails;
}

interface RunRow {
  id: string;
  ticket_id: string;
  status: Stage;
  iteration: number;
  max_iterations: number;
  branch: string | null;
  base_branch: string | null;
  mr_id: string | null;
  mr_url: string | null;
  mr_state: Run['mrState'];
  created_by: string;
  created_at: Date;
  finished_at: Date | null;
  budget_usd: string | null;
  team_context_version: number | null;
  paused: boolean;
}

const ticketColumns =
  'id, tracker, external_key, external_id, title, url, project_key, repo_id, details';
const runColumns =
  'id, ticket_id, status, iteration, max_iterations, branch, base_branch, mr_id, mr_url, mr_state, created_by, created_at, finished_at, budget_usd, team_context_version, paused';

function toTicket(r: TicketRow): Ticket {
  return {
    id: r.id,
    tracker: r.tracker,
    externalKey: r.external_key,
    externalId: r.external_id,
    title: r.title,
    url: r.url,
    projectKey: r.project_key,
    repoId: r.repo_id,
    details: r.details,
  };
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    status: r.status,
    iteration: r.iteration,
    maxIterations: r.max_iterations,
    branch: r.branch,
    baseBranch: r.base_branch,
    mrId: r.mr_id,
    mrUrl: r.mr_url,
    mrState: r.mr_state,
    createdBy: r.created_by,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    budgetUsd: r.budget_usd === null ? null : Number(r.budget_usd),
    teamContextVersion: r.team_context_version,
    paused: r.paused,
  };
}

export interface TicketInput {
  tracker?: string;
  externalKey: string;
  externalId?: string | null;
  title?: string;
  url?: string | null;
  projectKey?: string | null;
  details?: TicketDetails;
}

/** Inserts or refreshes a ticket by `(tracker, external_key)`. */
export async function upsertTicket(db: Queryable, input: TicketInput): Promise<Ticket> {
  const projectKey = input.projectKey ?? input.externalKey.split('-')[0] ?? null;
  const r = await db.query<TicketRow>(
    `INSERT INTO tickets (tracker, external_key, external_id, title, url, project_key, details)
     VALUES ($1, $2, $3, $4, $5, $6, $8)
     ON CONFLICT (tracker, external_key) DO UPDATE SET
       external_id = COALESCE(EXCLUDED.external_id, tickets.external_id),
       title = CASE WHEN $7 THEN EXCLUDED.title ELSE tickets.title END,
       url = COALESCE(EXCLUDED.url, tickets.url),
       project_key = COALESCE(EXCLUDED.project_key, tickets.project_key),
       details = CASE WHEN $9 THEN EXCLUDED.details ELSE tickets.details END
     RETURNING ${ticketColumns}`,
    [
      input.tracker ?? 'jira',
      input.externalKey,
      input.externalId ?? null,
      input.title ?? input.externalKey,
      input.url ?? null,
      projectKey,
      input.title !== undefined,
      JSON.stringify(input.details ?? {}),
      input.details !== undefined,
    ],
  );
  return toTicket(r.rows[0]!);
}

export async function findTicketByKey(
  db: Queryable,
  key: string,
  tracker = 'jira',
): Promise<Ticket | undefined> {
  const r = await db.query<TicketRow>(
    `SELECT ${ticketColumns} FROM tickets WHERE tracker = $1 AND external_key = $2`,
    [tracker, key],
  );
  return r.rows[0] ? toTicket(r.rows[0]) : undefined;
}

export async function updateTicketRepo(
  db: Queryable,
  ticketId: string,
  repoId: string,
): Promise<void> {
  await db.query('UPDATE tickets SET repo_id = $2 WHERE id = $1', [ticketId, repoId]);
}

export async function updateTicketDetails(
  db: Queryable,
  ticketId: string,
  details: TicketDetails,
): Promise<void> {
  await db.query('UPDATE tickets SET details = $2 WHERE id = $1', [
    ticketId,
    JSON.stringify(details),
  ]);
}

export async function findActiveRunForTicket(
  db: Queryable,
  ticketId: string,
): Promise<Run | undefined> {
  const r = await db.query<RunRow>(
    `SELECT ${runColumns} FROM runs WHERE ticket_id = $1 AND status NOT IN ('done','cancelled','failed')`,
    [ticketId],
  );
  return r.rows[0] ? toRun(r.rows[0]) : undefined;
}

/** Tickets whose active run is blocked for the given reason. */
export async function listTicketsWithRunsBlockedOn(
  db: Queryable,
  reason: BlockedReason,
): Promise<Ticket[]> {
  const r = await db.query<TicketRow & { run_id: string }>(
    `SELECT t.id, t.tracker, t.external_key, t.external_id, t.title, t.url, t.project_key, t.repo_id, t.details,
            r.id AS run_id
     FROM runs r JOIN tickets t ON t.id = r.ticket_id WHERE r.status = 'blocked'`,
  );
  const out: Ticket[] = [];
  for (const row of r.rows) {
    const p = await projectRunById(db, row.run_id);
    if (p.blockedReason === reason) out.push(toTicket(row));
  }
  return out;
}

export interface CreateRunInput {
  ticket: TicketInput;
  trigger: 'webhook' | 'poll' | 'manual';
  by: string;
  maxIterations: number;
  budgetUsd: number | null;
}

export interface CreateRunResult {
  run: Run;
  ticket: Ticket;
  /** `false` when the ticket already had an active run; that run is returned. */
  created: boolean;
}

/** Creates a run for the ticket unless one is already active (§5.1 item 1). */
export async function createRun(
  pool: Pool,
  bus: EventBus,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const result = await withTransaction(pool, async (client) => {
    const ticket = await upsertTicket(client, input.ticket);
    const active = await client.query<RunRow>(
      `SELECT ${runColumns} FROM runs WHERE ticket_id = $1 AND status NOT IN ('done','cancelled','failed')
       FOR UPDATE`,
      [ticket.id],
    );
    if (active.rows[0]) return { run: toRun(active.rows[0]), ticket, created: false, events: [] };
    const inserted = await client.query<RunRow>(
      `INSERT INTO runs (ticket_id, status, max_iterations, created_by, budget_usd)
       VALUES ($1, 'queued', $2, $3, $4) RETURNING ${runColumns}`,
      [ticket.id, input.maxIterations, input.by, input.budgetUsd],
    );
    const run = toRun(inserted.rows[0]!);
    const { events } = await appendEventsTx(client, run.id, [
      {
        type: 'run.created',
        payload: {
          ticket_key: ticket.externalKey,
          trigger: input.trigger,
          by: input.by,
          max_iterations: input.maxIterations,
          budget_usd: input.budgetUsd,
        },
      },
    ]);
    return { run, ticket, created: true, events };
  });
  bus.publish(result.run.id, result.events);
  return { run: result.run, ticket: result.ticket, created: result.created };
}

export async function findRun(db: Queryable, id: string): Promise<Run | undefined> {
  const r = await db.query<RunRow>(`SELECT ${runColumns} FROM runs WHERE id = $1`, [id]);
  return r.rows[0] ? toRun(r.rows[0]) : undefined;
}

export async function findTicket(db: Queryable, id: string): Promise<Ticket | undefined> {
  const r = await db.query<TicketRow>(`SELECT ${ticketColumns} FROM tickets WHERE id = $1`, [id]);
  return r.rows[0] ? toTicket(r.rows[0]) : undefined;
}

export interface RunDetail {
  run: Run;
  ticket: Ticket;
  projection: RunProjection;
}

export async function getRunDetail(db: Queryable, id: string): Promise<RunDetail | undefined> {
  const run = await findRun(db, id);
  if (!run) return undefined;
  const ticket = (await findTicket(db, run.ticketId))!;
  return { run, ticket, projection: await projectRunById(db, id) };
}

export interface ListRunsFilter {
  stage?: Stage | undefined;
  /** Default: active runs plus those finished in the last 24 h. */
  includeFinishedSince?: Date | undefined;
  ticketId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

/** Board data: runs with their projections, newest first. */
export async function listRuns(db: Queryable, filter: ListRunsFilter = {}): Promise<RunDetail[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    conds.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.stage) add('r.status = ?', filter.stage);
  else {
    const terminal = [...TERMINAL_STAGES];
    add(
      `(r.status <> ALL(?::text[]) OR r.finished_at >= ${filter.includeFinishedSince ? `$${params.length + 2}` : "now() - interval '24 hours'"})`,
      terminal,
    );
    if (filter.includeFinishedSince) params.push(filter.includeFinishedSince);
  }
  if (filter.ticketId) add('r.ticket_id = ?', filter.ticketId);
  if (filter.cursor)
    add('r.created_at < (SELECT created_at FROM runs WHERE id = ?)', filter.cursor);
  params.push(filter.limit ?? 200);
  const r = await db.query<RunRow & { t: TicketRow }>(
    `SELECT ${runColumns
      .split(', ')
      .map((c) => `r.${c}`)
      .join(', ')},
            json_build_object('id', t.id, 'tracker', t.tracker, 'external_key', t.external_key,
              'external_id', t.external_id, 'title', t.title, 'url', t.url,
              'project_key', t.project_key, 'repo_id', t.repo_id, 'details', t.details) AS t
     FROM runs r JOIN tickets t ON t.id = r.ticket_id
     ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
     ORDER BY r.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return Promise.all(
    r.rows.map(async (row) => ({
      run: toRun(row),
      ticket: toTicket(row.t),
      projection: await projectRunById(db, row.id),
    })),
  );
}

/** All runs of a ticket, newest first. */
export async function listRunsForTicket(db: Queryable, ticketId: string): Promise<RunDetail[]> {
  const r = await db.query<RunRow>(
    `SELECT ${runColumns} FROM runs WHERE ticket_id = $1 ORDER BY created_at DESC`,
    [ticketId],
  );
  const ticket = (await findTicket(db, ticketId))!;
  return Promise.all(
    r.rows.map(async (row) => ({
      run: toRun(row),
      ticket,
      projection: await projectRunById(db, row.id),
    })),
  );
}

export { listEvents };
export type { pg };
