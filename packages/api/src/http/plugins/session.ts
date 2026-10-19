import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../../db/pool.js';
import { createSession, deleteSession, findSession } from '../../auth/sessions.js';
import { hasRole, type Role, type User } from '../../auth/users.js';
import { forbidden, unauthorized } from '../errors.js';

/**
 * Cookie sessions + CSRF (§10.4).
 *
 * - `mates_session` (HttpOnly, SameSite=Lax, Secure behind TLS) carries the
 *   session token.
 * - `mates_csrf` (readable by the SPA) carries the CSRF token; every
 *   mutating request authenticated by cookie must repeat it in
 *   `x-csrf-token`.
 */
export const SESSION_COOKIE = 'mates_session';
export const CSRF_COOKIE = 'mates_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session plugin when a valid session cookie is present. */
    user: User | undefined;
  }
  interface FastifyInstance {
    /** Starts a session for `user` and sets the cookies on `reply`. */
    login(reply: FastifyReply, user: User): Promise<void>;
    /** Ends the current session and clears the cookies. */
    logout(request: FastifyRequest, reply: FastifyReply): Promise<void>;
    /** Route guard: 401 without a user, 403 below `role`. */
    requireRole(role: Role): (request: FastifyRequest) => Promise<void>;
  }
}

export interface SessionPluginOptions {
  db: Pool;
  secure: boolean;
}

export const sessionPlugin = fp<SessionPluginOptions>(async (app: FastifyInstance, opts) => {
  app.decorateRequest('user', undefined);

  app.addHook('onRequest', async (request) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await findSession(opts.db, token);
    if (!session) return;
    request.user = session.user;
    if (!SAFE_METHODS.has(request.method) && request.headers[CSRF_HEADER] !== session.csrfToken) {
      throw forbidden('missing or invalid CSRF token');
    }
  });

  app.decorate('login', async (reply: FastifyReply, user: User) => {
    const s = await createSession(opts.db, user.id);
    const common = {
      path: '/',
      sameSite: 'lax' as const,
      secure: opts.secure,
      expires: s.expiresAt,
    };
    void reply.setCookie(SESSION_COOKIE, s.token, { ...common, httpOnly: true });
    void reply.setCookie(CSRF_COOKIE, s.csrfToken, { ...common, httpOnly: false });
  });

  app.decorate('logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await deleteSession(opts.db, token);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    void reply.clearCookie(CSRF_COOKIE, { path: '/' });
  });

  app.decorate('requireRole', (role: Role) => async (request: FastifyRequest) => {
    if (!request.user) throw unauthorized();
    if (!hasRole(request.user.role, role)) throw forbidden(`requires role ${role}`);
  });
});
