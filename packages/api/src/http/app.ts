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
import type { Integrations } from '../integrations.js';
import type { AnthropicTest } from '../orchestrator/anthropic-test.js';
import type { Orchestrator } from '../orchestrator/reconciler.js';
import type { TrackerSync } from '../orchestrator/tracker-sync.js';
import type { EventBus } from '../runs/bus.js';
import type { RunStarter } from '../runs/starter.js';
import type { CredentialStore } from '../settings/credentials.js';
import type { SettingsService } from '../settings/service.js';
import type { Bootstrap } from '../setup/bootstrap.js';
import type { StatsService } from '../stats/service.js';
import type { TeamContextService } from '../team-context/service.js';
import { auditPlugin } from '../audit/log.js';
import { registerErrorHandler, sendNotFound } from './errors.js';
import { sessionPlugin } from './plugins/session.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes, type ReadinessDeps } from './routes/health.js';
import { internalRoutes } from './routes/internal.js';
import { runsRoutes } from './routes/runs.js';
import { settingsRoutes } from './routes/settings.js';
import { statsRoutes } from './routes/stats.js';
import { ticketRoutes } from './routes/tickets.js';
import { userRoutes } from './routes/users.js';
import { setupRoutes } from './routes/setup.js';
import { webhookRoutes } from './routes/webhooks.js';

export interface AppDeps {
  readonly db: Pool;
  readonly log: Logger;
  readonly bootstrap: Bootstrap;
  readonly bus: EventBus;
  readonly internalKey: string;
  readonly settings: SettingsService;
  readonly integrations: Integrations;
  readonly starter: RunStarter;
  readonly credentials: CredentialStore;
  readonly teamContext: TeamContextService;
  readonly orchestrator: Pick<Orchestrator, 'cancel' | 'pause' | 'resume' | 'retry'>;
  readonly trackerSync: Pick<TrackerSync, 'comment'>;
  readonly stats: StatsService;
  readonly anthropicTest: Pick<AnthropicTest, 'run'>;
  readonly fakeClaude: boolean;
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
  await app.register(auditPlugin, { db: deps.db });

  await healthRoutes(app, { db: deps.db, kubernetes: deps.kubernetes });
  await setupRoutes(app, deps.bootstrap);
  await authRoutes(app, deps.db);
  await runsRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    starter: deps.starter,
    orchestrator: deps.orchestrator,
    trackerSync: deps.trackerSync,
    settings: deps.settings,
  });
  await internalRoutes(app, {
    db: deps.db,
    bus: deps.bus,
    internalKey: deps.internalKey,
    context: {
      settings: deps.settings,
      teamContext: deps.teamContext,
      fakeClaude: deps.fakeClaude,
    },
  });
  await settingsRoutes(app, {
    db: deps.db,
    settings: deps.settings,
    credentials: deps.credentials,
    teamContext: deps.teamContext,
    integrations: deps.integrations,
    anthropicTest: deps.anthropicTest,
  });
  await statsRoutes(app, { stats: deps.stats, settings: deps.settings });
  await ticketRoutes(app, deps.db);
  await userRoutes(app, deps.db);
  await webhookRoutes(app, {
    settings: deps.settings,
    integrations: deps.integrations,
    starter: deps.starter,
    log: deps.log,
  });

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
