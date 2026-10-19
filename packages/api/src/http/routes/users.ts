import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createApiToken, deleteApiToken, listApiTokens } from '../../auth/api-tokens.js';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../../auth/password.js';
import {
  ROLES,
  createUser,
  deleteUser,
  findUserByEmail,
  listUsers,
  updateUserRole,
} from '../../auth/users.js';
import type { Pool } from '../../db/pool.js';
import { AppError, badRequest, forbidden, notFound } from '../errors.js';
import { userSchema } from './auth.js';

const tokenView = z.object({
  id: z.string(),
  name: z.string(),
  userEmail: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});

/** Users (admin) and personal API tokens (own; admins see all) — §12, §10.4. */
export async function userRoutes(app: FastifyInstance, db: Pool): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const admin = app.requireRole('admin');
  const viewer = app.requireRole('viewer');

  r.get(
    '/api/users',
    {
      preHandler: admin,
      schema: { tags: ['users'], response: { 200: z.object({ users: z.array(userSchema) }) } },
    },
    async () => ({
      users: await listUsers(db),
    }),
  );

  r.post(
    '/api/users',
    {
      preHandler: admin,
      schema: {
        tags: ['users'],
        body: z.object({
          email: z.string().email(),
          displayName: z.string().min(1).max(100),
          role: z.enum(ROLES),
          password: z.string().min(MIN_PASSWORD_LENGTH),
        }),
        response: { 201: userSchema },
      },
    },
    async (req, reply) => {
      if (await findUserByEmail(db, req.body.email))
        throw new AppError(409, 'user_exists', 'a user with this email already exists');
      const user = await createUser(db, {
        email: req.body.email,
        displayName: req.body.displayName,
        role: req.body.role,
        auth: 'local',
        passwordHash: await hashPassword(req.body.password),
      });
      await req.audit('audit.user.create', user.email, { role: user.role });
      return reply.status(201).send(user);
    },
  );

  r.put(
    '/api/users/:id',
    {
      preHandler: admin,
      schema: {
        tags: ['users'],
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ role: z.enum(ROLES) }),
        response: { 200: userSchema },
      },
    },
    async (req) => {
      if (req.params.id === req.user!.id && req.body.role !== 'admin')
        throw badRequest('self_demotion', 'you cannot remove your own admin role');
      const user = await updateUserRole(db, req.params.id, req.body.role);
      if (!user) throw notFound('user');
      await req.audit('audit.user.role', user.email, { role: user.role });
      return user;
    },
  );

  r.delete(
    '/api/users/:id',
    {
      preHandler: admin,
      schema: {
        tags: ['users'],
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      if (req.params.id === req.user!.id)
        throw badRequest('self_delete', 'you cannot delete your own account');
      if (!(await deleteUser(db, req.params.id))) throw notFound('user');
      await req.audit('audit.user.delete', req.params.id);
      return reply.status(204).send(null);
    },
  );

  r.get(
    '/api/api-tokens',
    {
      preHandler: viewer,
      schema: { tags: ['users'], response: { 200: z.object({ tokens: z.array(tokenView) }) } },
    },
    async (req) => {
      const rows = await listApiTokens(db, req.user!.role === 'admin' ? undefined : req.user!.id);
      return {
        tokens: rows.map((t) => ({
          id: t.id,
          name: t.name,
          userEmail: t.userEmail,
          createdAt: t.createdAt.toISOString(),
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  r.post(
    '/api/api-tokens',
    {
      preHandler: viewer,
      schema: {
        tags: ['users'],
        body: z.object({ name: z.string().min(1).max(100) }),
        response: { 201: z.object({ id: z.string(), name: z.string(), token: z.string() }) },
      },
    },
    async (req, reply) => {
      const { token, record } = await createApiToken(db, req.user!.id, req.body.name);
      await req.audit('audit.token.create', record.id, { name: record.name });
      return reply.status(201).send({ id: record.id, name: record.name, token });
    },
  );

  r.delete(
    '/api/api-tokens/:id',
    {
      preHandler: viewer,
      schema: {
        tags: ['users'],
        params: z.object({ id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const ok = await deleteApiToken(
        db,
        req.params.id,
        req.user!.role === 'admin' ? undefined : req.user!.id,
      );
      if (!ok) throw req.user!.role === 'admin' ? notFound('token') : forbidden('not your token');
      await req.audit('audit.token.delete', req.params.id);
      return reply.status(204).send(null);
    },
  );
}
