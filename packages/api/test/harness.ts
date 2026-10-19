import type { FastifyInstance } from 'fastify';
import { createUser, type Role } from '../src/auth/users.js';
import { hashPassword } from '../src/auth/password.js';
import { buildApp } from '../src/http/app.js';
import { createLogger } from '../src/logger.js';
import { EventBus } from '../src/runs/bus.js';
import { InMemorySecretStore } from '../src/secrets/store.js';
import { Bootstrap } from '../src/setup/bootstrap.js';
import { freshDatabase, type TestDatabase } from './db.js';

/** A ready app on a fresh database with one user per role, logged in. */
export const INTERNAL_KEY = 'k'.repeat(32);

export interface TestApp {
  app: FastifyInstance;
  db: TestDatabase;
  bus: EventBus;
  /** Request headers (cookie + CSRF) for a user with the given role. */
  as(role: Role): Record<string, string>;
  close(): Promise<void>;
}

export async function testApp(): Promise<TestApp> {
  const db = await freshDatabase();
  const bus = new EventBus();
  const log = createLogger('silent');
  const bootstrap = new Bootstrap({
    db: db.pool,
    secrets: new InMemorySecretStore(),
    release: 'mates',
    log,
  });
  const app = await buildApp({
    db: db.pool,
    log,
    bootstrap,
    bus,
    internalKey: INTERNAL_KEY,
    runDefaults: { maxIterations: 4, budgetUsd: 25 },
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
    as: (role) => headers[role]!,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
