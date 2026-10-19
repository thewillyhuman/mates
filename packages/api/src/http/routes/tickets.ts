import { STAGES } from '@mates/core';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { findTicketByKey, listRunsForTicket } from '../../runs/repository.js';
import { listTickets, ticketsToCsv, type TicketFilter } from '../../runs/tickets.js';
import { runSummarySchema, toRunSummary } from '../../runs/views.js';
import { notFound } from '../errors.js';

const latestRun = z.object({
  id: z.string(),
  stage: z.string(),
  iteration: z.number(),
  maxIterations: z.number(),
  costUsd: z.number(),
  mrUrl: z.string().nullable(),
  mrState: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
const ticketRow = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  projectKey: z.string().nullable(),
  repoId: z.string().nullable(),
  createdAt: z.string(),
  runs: z.number(),
  latestRun: latestRun.nullable(),
});

const filters = z.object({
  project: z.string().optional(),
  repo: z.string().optional(),
  stage: z.enum(STAGES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.string().uuid().optional(),
});

function serialise(t: Awaited<ReturnType<typeof listTickets>>[number]) {
  return {
    ...t,
    createdAt: t.createdAt.toISOString(),
    latestRun: t.latestRun
      ? {
          ...t.latestRun,
          createdAt: t.latestRun.createdAt.toISOString(),
          finishedAt: t.latestRun.finishedAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** Tickets table, CSV export and ticket detail (§12, §13.3). */
export async function ticketRoutes(app: FastifyInstance, db: Pool): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const viewer = app.requireRole('viewer');

  r.get(
    '/api/tickets',
    {
      preHandler: viewer,
      schema: {
        tags: ['tickets'],
        querystring: filters,
        response: { 200: z.object({ tickets: z.array(ticketRow) }) },
      },
    },
    async (req) => ({ tickets: (await listTickets(db, req.query as TicketFilter)).map(serialise) }),
  );

  r.get(
    '/api/tickets.csv',
    { preHandler: viewer, schema: { tags: ['tickets'], querystring: filters, hide: true } },
    async (req, reply) => {
      const csv = ticketsToCsv(
        await listTickets(db, { ...(req.query as TicketFilter), limit: 1000 }),
      );
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="tickets.csv"')
        .send(csv);
    },
  );

  r.get(
    '/api/tickets/:key',
    {
      preHandler: viewer,
      schema: {
        tags: ['tickets'],
        params: z.object({ key: z.string() }),
        response: {
          200: z.object({
            ticket: ticketRow.omit({ latestRun: true, runs: true }),
            runs: z.array(runSummarySchema),
          }),
        },
      },
    },
    async (req) => {
      const ticket = await findTicketByKey(db, req.params.key);
      if (!ticket) throw notFound('ticket');
      const runs = await listRunsForTicket(db, ticket.id);
      return {
        ticket: {
          id: ticket.id,
          key: ticket.externalKey,
          title: ticket.title,
          url: ticket.url,
          projectKey: ticket.projectKey,
          repoId: ticket.repoId,
          createdAt: new Date().toISOString(),
        },
        runs: runs.map(toRunSummary),
      };
    },
  );
}
