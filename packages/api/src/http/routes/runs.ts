import { STAGES, type RunEvent } from '@mates/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import type { EventBus } from '../../runs/bus.js';
import { listEvents } from '../../runs/events.js';
import { createRun, findRun, getRunDetail, listRuns } from '../../runs/repository.js';
import { runDetailSchema, runSummarySchema, toRunDetail, toRunSummary } from '../../runs/views.js';
import type { RunDefaults } from '../../settings/helm.js';
import { notFound } from '../errors.js';
import { openSse, sendRunEvents } from '../sse.js';

export interface RunsRouteDeps {
  db: Pool;
  bus: EventBus;
  defaults: RunDefaults;
}

const eventSchema = z.object({
  id: z.number(),
  run_id: z.string(),
  invocation_id: z.string().nullable(),
  ts: z.string(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
});

/** Runs: board listing, detail, event log, SSE streams and manual trigger (§12). */
export async function runsRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const viewer = app.requireRole('viewer');
  const operator = app.requireRole('operator');

  r.get(
    '/api/runs',
    {
      preHandler: viewer,
      schema: {
        tags: ['runs'],
        querystring: z.object({
          stage: z.enum(STAGES).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
          cursor: z.string().optional(),
        }),
        response: { 200: z.object({ runs: z.array(runSummarySchema) }) },
      },
    },
    async (req) => {
      const runs = await listRuns(deps.db, {
        stage: req.query.stage,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return { runs: runs.map(toRunSummary) };
    },
  );

  r.post(
    '/api/runs',
    {
      preHandler: operator,
      schema: {
        tags: ['runs'],
        body: z.object({
          ticket_key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, 'Jira key like API-198'),
        }),
        response: { 200: runDetailSchema, 201: runDetailSchema },
      },
    },
    async (req, reply) => {
      const result = await createRun(deps.db, deps.bus, {
        ticket: { externalKey: req.body.ticket_key },
        trigger: 'manual',
        by: req.user!.email,
        maxIterations: deps.defaults.maxIterations,
        budgetUsd: deps.defaults.budgetUsd,
      });
      const detail = (await getRunDetail(deps.db, result.run.id))!;
      return reply.status(result.created ? 201 : 200).send(toRunDetail(detail));
    },
  );

  r.get(
    '/api/runs/:id',
    {
      preHandler: viewer,
      schema: {
        tags: ['runs'],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: runDetailSchema },
      },
    },
    async (req) => {
      const detail = await getRunDetail(deps.db, req.params.id);
      if (!detail) throw notFound('run');
      return toRunDetail(detail);
    },
  );

  r.get(
    '/api/runs/:id/events',
    {
      preHandler: viewer,
      schema: {
        tags: ['runs'],
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({
          after: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(5000).default(1000),
        }),
        response: {
          200: z.object({ events: z.array(eventSchema), next_after: z.number().nullable() }),
        },
      },
    },
    async (req) => {
      if (!(await findRun(deps.db, req.params.id))) throw notFound('run');
      // Fetch one extra row to know whether a next page exists.
      const rows = await listEvents(deps.db, req.params.id, {
        after: req.query.after,
        limit: req.query.limit + 1,
      });
      const events = rows.slice(0, req.query.limit);
      const more = rows.length > req.query.limit;
      return { events, next_after: more ? events.at(-1)!.id : null };
    },
  );

  // SSE for one run: replays events after the cursor, then streams live ones.
  r.get(
    '/api/runs/:id/stream',
    {
      preHandler: viewer,
      schema: {
        tags: ['runs'],
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ after: z.coerce.number().int().min(0).default(0) }),
        hide: true,
      },
    },
    async (req, reply) => {
      const run = await findRun(deps.db, req.params.id);
      if (!run) throw notFound('run');
      let lastId = req.query.after;
      let ready = false;
      const pending: RunEvent[] = [];
      const unsubscribe = deps.bus.subscribe(run.id, (events) => {
        if (!ready) {
          pending.push(...events);
          return;
        }
        deliver(events);
      });
      const stream = openSse(req, reply, unsubscribe);
      const deliver = (events: RunEvent[]) => {
        const fresh = events.filter((e) => e.id > lastId);
        if (fresh.length === 0) return;
        lastId = fresh.at(-1)!.id;
        sendRunEvents(stream, fresh);
      };
      deliver(await listEvents(deps.db, run.id, { after: lastId }));
      ready = true;
      deliver(pending.splice(0));
      return reply;
    },
  );

  // Global SSE for the board: a `run` summary whenever a run's log grows.
  r.get(
    '/api/stream',
    { preHandler: viewer, schema: { tags: ['runs'], hide: true } },
    async (req, reply) => {
      const timers = new Map<string, NodeJS.Timeout>();
      const flush = async (runId: string) => {
        timers.delete(runId);
        const detail = await getRunDetail(deps.db, runId);
        if (detail && !stream.closed)
          stream.send('run', toRunSummary(detail), detail.projection.lastEventId);
      };
      const unsubscribe = deps.bus.subscribe('*', (events) => {
        const runId = events[0]?.run_id;
        if (!runId || timers.has(runId)) return;
        // Coalesce bursts (tail lines) into one summary per run per 300 ms.
        timers.set(
          runId,
          setTimeout(() => void flush(runId).catch(() => undefined), 300),
        );
      });
      const stream = openSse(req, reply, () => {
        unsubscribe();
        for (const t of timers.values()) clearTimeout(t);
      });
      stream.comment('connected');
      return reply;
    },
  );
}
