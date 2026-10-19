import type { FastifyInstance } from 'fastify';
import { createUser, type Role } from '../src/auth/users.js';
import { hashPassword } from '../src/auth/password.js';
import { buildApp } from '../src/http/app.js';
import { FakeJobsClient } from '../src/kubernetes/jobs.js';
import { createLogger } from '../src/logger.js';
import { JobMonitor } from '../src/orchestrator/monitor.js';
import { Orchestrator } from '../src/orchestrator/reconciler.js';
import { InvocationSpawner } from '../src/orchestrator/spawner.js';
import { EventBus } from '../src/runs/bus.js';
import { InMemorySecretStore } from '../src/secrets/store.js';
import { CredentialStore } from '../src/settings/credentials.js';
import type { HelmConfig } from '../src/settings/helm.js';
import { SettingsService } from '../src/settings/service.js';
import { Bootstrap } from '../src/setup/bootstrap.js';
import { TeamContextService } from '../src/team-context/service.js';
import { freshDatabase, type TestDatabase } from './db.js';

/**
 * A ready app on a fresh database with one user per role, logged in, and
 * every service wired to in-memory fakes (secrets, Kubernetes jobs).
 */
export const INTERNAL_KEY = 'k'.repeat(32);

export interface TestApp {
  app: FastifyInstance;
  db: TestDatabase;
  bus: EventBus;
  jobs: FakeJobsClient;
  secrets: InMemorySecretStore;
  settings: SettingsService;
  credentials: CredentialStore;
  teamContext: TeamContextService;
  orchestrator: Orchestrator;
  monitor: JobMonitor;
  /** Request headers (cookie + CSRF) for a user with the given role. */
  as(role: Role): Record<string, string>;
  close(): Promise<void>;
}

export async function testApp(
  opts: { helm?: HelmConfig; fakeClaude?: boolean } = {},
): Promise<TestApp> {
  const db = await freshDatabase();
  const bus = new EventBus();
  const log = createLogger('silent');
  const secrets = new InMemorySecretStore();
  const jobs = new FakeJobsClient();
  const helm = opts.helm ?? {};
  const fakeClaude = opts.fakeClaude ?? true;
  const bootstrap = new Bootstrap({ db: db.pool, secrets, release: 'mates', log });
  const settings = new SettingsService(db.pool, helm);
  const credentials = new CredentialStore(
    secrets,
    db.pool,
    'mates',
    helm.credentialsReadOnly ?? false,
  );
  const teamContext = new TeamContextService(db.pool, async () =>
    (await settings.get()).scm.providers.map((p) => p.id),
  );
  const spawner = new InvocationSpawner({
    db: db.pool,
    bus,
    jobs,
    log,
    internalKey: INTERNAL_KEY,
    release: 'mates',
    namespace: 'mates',
    apiInternalUrl: 'http://mates.mates.svc:8080',
    fakeClaude,
    helm,
    defaultRunnerImage: 'mates-runner:test',
  });
  const orchestrator = new Orchestrator({ db: db.pool, bus, log, settings, teamContext, spawner });
  const monitor = new JobMonitor({ db: db.pool, bus, jobs, log, graceMs: 0 });
  const app = await buildApp({
    db: db.pool,
    log,
    bootstrap,
    bus,
    internalKey: INTERNAL_KEY,
    runDefaults: { maxIterations: 4, budgetUsd: 25 },
    settings,
    credentials,
    teamContext,
    orchestrator,
    fakeClaude,
    secureCookies: false,
    version: 'test',
  });
  await app.ready();

  const headers: Partial<Record<Role, Record<string, string>>> = {};
  const passwordHash = await hashPassword('password-for-tests');
  for (const role of ['viewer', 'operator', 'admin'] as const) {
    await createUser(db.pool, {
      email: `${role}@example.com`,
      displayName: role,
      role,
      auth: 'local',
      passwordHash,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: `${role}@example.com`, password: 'password-for-tests' },
    });
    const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const csrf = res.cookies.find((c) => c.name === 'mates_csrf')!.value;
    headers[role] = { cookie, 'x-csrf-token': csrf };
  }

  return {
    app,
    db,
    bus,
    jobs,
    secrets,
    settings,
    credentials,
    teamContext,
    orchestrator,
    monitor,
    as: (role) => headers[role]!,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
