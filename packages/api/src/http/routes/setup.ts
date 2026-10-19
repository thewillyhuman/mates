import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH } from '../../auth/password.js';
import {
  type Bootstrap,
  InvalidSetupTokenError,
  SetupDisabledError,
} from '../../setup/bootstrap.js';
import { AppError } from '../errors.js';

/** First-run setup endpoints (§6.1). */
export async function setupRoutes(app: FastifyInstance, bootstrap: Bootstrap): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/setup/status',
    {
      schema: {
        tags: ['setup'],
        response: { 200: z.object({ setupRequired: z.boolean() }) },
      },
    },
    async () => ({ setupRequired: await bootstrap.isRequired() }),
  );

  r.post(
    '/api/setup/bootstrap',
    {
      schema: {
        tags: ['setup'],
        body: z.object({
          token: z.string().min(1),
          email: z.string().email(),
          password: z.string().min(MIN_PASSWORD_LENGTH),
        }),
        response: {
          201: z.object({ id: z.string(), email: z.string(), role: z.string() }),
        },
      },
    },
    async (req, reply) => {
      try {
        const user = await bootstrap.complete(req.body);
        await app.login(reply, user);
        return reply.status(201).send({ id: user.id, email: user.email, role: user.role });
      } catch (err) {
        if (err instanceof SetupDisabledError)
          throw new AppError(410, 'setup_disabled', err.message);
        if (err instanceof InvalidSetupTokenError)
          throw new AppError(401, 'invalid_token', err.message);
        throw err;
      }
    },
  );
}
