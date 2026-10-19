import { EventValidationError, RUNNER_EVENT_TYPES, parseEvent, type NewEvent } from '@mates/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { InvalidInvocationTokenError, verifyInvocationToken } from '../../auth/invocation-token.js';
import type { Pool } from '../../db/pool.js';
import type { EventBus } from '../../runs/bus.js';
import { appendEvents, countTailEvents } from '../../runs/events.js';
import {
  findInvocation,
  markInvocationFinished,
  markInvocationStarted,
  markInvocationStatus,
  type Invocation,
} from '../../runs/invocations.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../errors.js';

export interface InternalRouteDeps {
  db: Pool;
  bus: EventBus;
  internalKey: string;
}

/** Live-tail lines kept per invocation before the rest is dropped (§17.4). */
export const TAIL_CAP = 5000;
const MAX_BATCH = 200;
const TAIL_TYPES = new Set(['invocation.tool_use', 'invocation.text']);

/**
 * Runner-only endpoints, authenticated with the per-invocation JWT (§5.1
 * item 4). The token's subject must match the invocation in the path.
 */
export async function internalRoutes(app: FastifyInstance, deps: InternalRouteDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  async function authenticate(req: FastifyRequest, invocationId: string): Promise<Invocation> {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw unauthorized('invocation token required');
    let claims;
    try {
      claims = await verifyInvocationToken(deps.internalKey, token);
    } catch (err) {
      if (err instanceof InvalidInvocationTokenError) throw unauthorized(err.message);
      throw err;
    }
    if (claims.invocationId !== invocationId) throw forbidden('token is for another invocation');
    const invocation = await findInvocation(deps.db, invocationId);
    if (!invocation) throw notFound('invocation');
    if (invocation.runId !== claims.runId) throw forbidden('token is for another run');
    return invocation;
  }

  r.post(
    '/internal/invocations/:id/events',
    {
      schema: {
        tags: ['internal'],
        params: z.object({ id: z.string().uuid() }),
        body: z.array(z.unknown()).min(1).max(MAX_BATCH),
        response: { 202: z.object({ accepted: z.number(), dropped: z.number() }) },
      },
    },
    async (req, reply) => {
      const invocation = await authenticate(req, req.params.id);
      const events: NewEvent[] = [];
      for (const raw of req.body) {
        let e: NewEvent;
        try {
          e = parseEvent(raw);
        } catch (err) {
          if (err instanceof EventValidationError) throw badRequest('invalid_event', err.message);
          throw err;
        }
        if (!RUNNER_EVENT_TYPES.has(e.type)) {
          throw new AppError(400, 'event_not_allowed', `runners may not emit ${e.type}`);
        }
        e.invocation_id = invocation.id;
        events.push(e);
      }

      const { kept, dropped } = await capTail(deps.db, invocation.id, events);
      await applyInvocationSideEffects(deps.db, invocation.id, kept);
      await appendEvents(deps.db, deps.bus, invocation.runId, kept);
      return reply.status(202).send({ accepted: kept.length, dropped });
    },
  );
}

/** Drops tail lines beyond `TAIL_CAP`, adding one marker line when the cap is first crossed. */
async function capTail(
  db: Pool,
  invocationId: string,
  events: NewEvent[],
): Promise<{ kept: NewEvent[]; dropped: number }> {
  const incomingTail = events.filter((e) => TAIL_TYPES.has(e.type)).length;
  if (incomingTail === 0) return { kept: events, dropped: 0 };
  let count = await countTailEvents(db, invocationId);
  if (count + incomingTail <= TAIL_CAP) return { kept: events, dropped: 0 };
  const kept: NewEvent[] = [];
  let dropped = 0;
  for (const e of events) {
    if (!TAIL_TYPES.has(e.type)) {
      kept.push(e);
      continue;
    }
    if (count < TAIL_CAP) {
      kept.push(e);
      count += 1;
      if (count === TAIL_CAP) {
        kept.push({
          type: 'invocation.text',
          payload: { text: `[live tail truncated after ${TAIL_CAP} lines]` },
          invocation_id: invocationId,
        });
      }
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped };
}

/** Keeps the `invocations` row's status in step with the lifecycle events. */
async function applyInvocationSideEffects(
  db: Pool,
  invocationId: string,
  events: NewEvent[],
): Promise<void> {
  for (const e of events) {
    switch (e.type) {
      case 'invocation.started':
        await markInvocationStarted(db, invocationId, e.payload.pod_name);
        break;
      case 'invocation.finished':
        await markInvocationFinished(db, invocationId, {
          exitCode: e.payload.exit_code,
          sessionId: e.payload.session_id,
          result: e.payload.result,
        });
        break;
      case 'invocation.failed':
        await markInvocationStatus(db, invocationId, 'failed');
        break;
      default:
        break;
    }
  }
}
