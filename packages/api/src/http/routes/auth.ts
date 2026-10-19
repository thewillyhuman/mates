import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Pool } from '../../db/pool.js';
import { verifyPassword } from '../../auth/password.js';
import { findUserByEmail } from '../../auth/users.js';
import { unauthorized } from '../errors.js';

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['viewer', 'operator', 'admin']),
  auth: z.enum(['local', 'oidc']),
});

/** Local login/logout/me (§10.4). OIDC is added in M7. */
export async function authRoutes(app: FastifyInstance, db: Pool): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/api/auth/login',
    {
      schema: {
        tags: ['auth'],
        body: z.object({ email: z.string().email(), password: z.string().min(1) }),
        response: { 200: userSchema },
      },
    },
    async (req, reply) => {
      const user = await findUserByEmail(db, req.body.email);
      const ok = user?.passwordHash
        ? await verifyPassword(user.passwordHash, req.body.password)
        : false;
      if (!user || !ok) throw unauthorized('invalid email or password');
      await app.login(reply, user);
      return userSchema.parse(user);
    },
  );

  r.post(
    '/api/auth/logout',
    { schema: { tags: ['auth'], response: { 204: z.null() } } },
    async (req, reply) => {
      await app.logout(req, reply);
      return reply.status(204).send(null);
    },
  );

  r.get(
    '/api/auth/me',
    { schema: { tags: ['auth'], response: { 200: userSchema } } },
    async (req) => {
      if (!req.user) throw unauthorized();
      return userSchema.parse(req.user);
    },
  );
}
