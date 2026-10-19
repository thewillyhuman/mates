import fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { Bootstrap } from '../setup/bootstrap.js';
import { registerErrorHandler, sendNotFound } from './errors.js';
import { sessionPlugin } from './plugins/session.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes, type ReadinessDeps } from './routes/health.js';
import { setupRoutes } from './routes/setup.js';

export interface AppDeps {
  readonly db: Pool;
  readonly log: Logger;
  readonly bootstrap: Bootstrap;
  readonly kubernetes?: ReadinessDeps['kubernetes'];
  /** Cookies are marked Secure when the public URL is https. */
  readonly secureCookies: boolean;
  /** Built UI directory; when set and present, served at `/` with SPA fallback. */
  readonly uiDir?: string | undefined;
  readonly version: string;
}

/** Assembles the Fastify app. No listening here; `main.ts` does that. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app: FastifyInstance = fastify({
    // pino's Logger is a superset of FastifyBaseLogger; the up-cast keeps the
    // instance type at Fastify's default so route modules stay generic.
    loggerInstance: deps.log as FastifyBaseLogger,
    // Per-request access lines are noise at info level; errors are logged by the error handler.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: true,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Mates API', version: deps.version },
    },
    transform: jsonSchemaTransform,
  });
  app.get('/api/openapi.json', async () => app.swagger());

  await app.register(cookie);
  await app.register(sessionPlugin, { db: deps.db, secure: deps.secureCookies });

  await healthRoutes(app, { db: deps.db, kubernetes: deps.kubernetes });
  await setupRoutes(app, deps.bootstrap);
  await authRoutes(app, deps.db);

  const serveUi = deps.uiDir !== undefined && (await exists(deps.uiDir));
  if (serveUi) {
    await app.register(fastifyStatic, { root: path.resolve(deps.uiDir!), wildcard: false });
  }
  // One not-found handler: JSON for API/webhook routes, SPA fallback otherwise.
  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith('/api/') || req.url.startsWith('/webhooks/');
    if (isApi || !serveUi) return sendNotFound(reply);
    return reply.sendFile('index.html');
  });

  return app;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
