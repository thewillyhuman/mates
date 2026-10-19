import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { OidcError, type OidcClient, type PendingLogin } from '../../auth/oidc.js';
import type { Pool } from '../../db/pool.js';
import { AppError } from '../errors.js';

export interface OidcRouteDeps {
  db: Pool;
  /** Resolved lazily so a client secret stored later is picked up. */
  client: () => Promise<OidcClient | undefined>;
  secureCookies: boolean;
}

const LOGIN_COOKIE = 'mates_oidc';

/** `/api/auth/oidc/config|start|callback` (§10.4, §12). */
export async function oidcRoutes(app: FastifyInstance, deps: OidcRouteDeps): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/api/auth/oidc/config',
    { schema: { tags: ['auth'], response: { 200: z.object({ enabled: z.boolean() }) } } },
    async () => ({
      enabled: (await deps.client()) !== undefined,
    }),
  );

  r.get(
    '/api/auth/oidc/start',
    {
      schema: {
        tags: ['auth'],
        querystring: z.object({ return_to: z.string().default('/') }),
        hide: true,
      },
    },
    async (req, reply) => {
      const client = await deps.client();
      if (!client) throw new AppError(404, 'oidc_disabled', 'OIDC is not configured');
      const returnTo = req.query.return_to.startsWith('/') ? req.query.return_to : '/';
      const { url, pending } = await client.start(returnTo);
      void reply.setCookie(
        LOGIN_COOKIE,
        Buffer.from(JSON.stringify(pending)).toString('base64url'),
        {
          path: '/api/auth/oidc',
          httpOnly: true,
          sameSite: 'lax',
          secure: deps.secureCookies,
          maxAge: 600,
        },
      );
      return reply.redirect(url, 302);
    },
  );

  r.get(
    '/api/auth/oidc/callback',
    {
      schema: {
        tags: ['auth'],
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
        hide: true,
      },
    },
    async (req, reply) => {
      const client = await deps.client();
      if (!client) throw new AppError(404, 'oidc_disabled', 'OIDC is not configured');
      const raw = req.cookies[LOGIN_COOKIE];
      if (!raw) throw new AppError(400, 'oidc_no_login', 'no login in progress; start again');
      const pending = JSON.parse(Buffer.from(raw, 'base64url').toString()) as PendingLogin;
      void reply.clearCookie(LOGIN_COOKIE, { path: '/api/auth/oidc' });
      try {
        const identity = await client.callback(req.query, pending);
        const user = await client.upsertUser(deps.db, identity);
        await app.login(reply, user);
        await req.audit('audit.auth.oidc_login', user.email, { groups: identity.groups.length });
        return reply.redirect(pending.returnTo || '/', 302);
      } catch (err) {
        if (err instanceof OidcError) throw new AppError(401, 'oidc_failed', err.message);
        throw err;
      }
    },
  );
}
