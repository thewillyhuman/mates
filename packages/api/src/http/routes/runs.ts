import { STAGES, type RunEvent } from '@mates/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import type { Orchestrator } from '../../orchestrator/reconciler.js';
import type { TrackerSync } from '../../orchestrator/tracker-sync.js';
import type { Settings } from '../../settings/schema.js';
import { getBlob } from '../../runs/blobs.js';
import { createNudge } from '../../runs/nudges.js';
import { appendEvents } from '../../runs/events.js';
import type { EventBus } from '../../runs/bus.js';
import { listEvents } from '../../runs/events.js';
import { findRun, getRunDetail, listRuns } from '../../runs/repository.js';
import type { RunStarter } from '../../runs/starter.js';
import { runDetailSchema, runSummarySchema, toRunDetail, toRunSummary } from '../../runs/views.js';
import { forbidden, notFound } from '../errors.js';
import { openSse, sendRunEvents } from '../sse.js';

export interface RunsRouteDeps {
  db: Pool;
  bus: EventBus;
  starter: Pick<RunStarter, 'start'>;
  orchestrator: Pick<Orchestrator, 'cancel' | 'pause' | 'resume' | 'retry'>;
  trackerSync: Pick<TrackerSync, 'comment'>;
  settings: { get(): Promise<Settings> };
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
      const result = await deps.starter.start(req.body.ticket_key, 'manual', req.user!.email);
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

  r.post(
    '/api/runs/:id/cancel',
    {
      preHandler: operator,
      schema: {
        tags: ['runs'],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ reason: z.string().max(500).default('') }).default({ reason: '' }),
        response: { 200: runDetailSchema },
      },
    },
    async (req) => {
      if (!(await findRun(deps.db, req.params.id))) throw notFound('run');
      await deps.orchestrator.cancel(req.params.id, req.user!.email, req.body.reason);
      return toRunDetail((await getRunDetail(deps.db, req.params.id))!);
    },
  );

  const idParam = z.object({ id: z.string().uuid() });
  const detailOf = async (id: string) => toRunDetail((await getRunDetail(deps.db, id))!);
  const mustExist = async (id: string) => {
    if (!(await findRun(deps.db, id))) throw notFound('run');
  };

  r.post(
    '/api/runs/:id/pause',
    {
      preHandler: operator,
      schema: { tags: ['runs'], params: idParam, response: { 200: runDetailSchema } },
    },
    async (req) => {
      await mustExist(req.params.id);
      await deps.orchestrator.pause(req.params.id, req.user!.email);
      return detailOf(req.params.id);
    },
  );

  r.post(
    '/api/runs/:id/resume',
    {
      preHandler: operator,
      schema: { tags: ['runs'], params: idParam, response: { 200: runDetailSchema } },
    },
    async (req) => {
      await mustExist(req.params.id);
      await deps.orchestrator.resume(req.params.id, req.user!.email);
      return detailOf(req.params.id);
    },
  );

  // blocked → queued (decision 0015); may raise the per-run budget.
  r.post(
    '/api/runs/:id/retry',
    {
      preHandler: operator,
      schema: {
        tags: ['runs'],
        params: idParam,
        body: z.object({ budget_usd: z.number().positive().optional() }).default({}),
        response: { 200: runDetailSchema },
      },
    },
    async (req) => {
      await mustExist(req.params.id);
      await deps.orchestrator.retry(req.params.id, req.user!.email, req.body.budget_usd);
      return detailOf(req.params.id);
    },
  );

  r.post(
    '/api/runs/:id/nudges',
    {
      preHandler: operator,
      schema: {
        tags: ['runs'],
        params: idParam,
        body: z.object({
          text: z.string().min(1).max(4000),
          post_to_tracker: z.boolean().default(false),
          and_retry: z.boolean().default(false),
        }),
        response: { 201: runDetailSchema },
      },
    },
    async (req, reply) => {
      await mustExist(req.params.id);
      const by = req.user!.displayName || req.user!.email;
      const nudge = await createNudge(deps.db, deps.bus, {
        runId: req.params.id,
        author: by,
        text: req.body.text,
        postToTracker: req.body.post_to_tracker,
      });
      if (req.body.post_to_tracker) {
        const detail = (await getRunDetail(deps.db, req.params.id))!;
        const { events } = await deps.trackerSync.comment(
          detail.ticket.externalKey,
          req.params.id,
          `Note from ${by} for the next iteration: "${nudge.text}"`,
          'nudge_echo',
          await deps.settings.get(),
        );
        await appendEvents(deps.db, deps.bus, req.params.id, events);
      }
      if (req.body.and_retry) await deps.orchestrator.retry(req.params.id, req.user!.email);
      return reply.status(201).send(await detailOf(req.params.id));
    },
  );

  r.get(
    '/api/runs/:id/blobs/:blobId',
    {
      preHandler: viewer,
      schema: {
        tags: ['runs'],
        params: z.object({ id: z.string().uuid(), blobId: z.string().uuid() }),
        hide: true,
      },
    },
    async (req, reply) => {
      const blob = await getBlob(deps.db, req.params.blobId);
      if (!blob || blob.runId !== req.params.id) throw notFound('blob');
      // Transcripts may contain more than operators should share with viewers (§12).
      if (blob.kind === 'transcript' && req.user!.role === 'viewer')
        throw forbidden('transcripts require the operator role');
      return reply
        .header('content-type', blob.contentType)
        .header('content-length', String(blob.sizeBytes))
        .send(blob.data);
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
