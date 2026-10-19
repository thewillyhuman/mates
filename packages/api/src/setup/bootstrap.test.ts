import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, stopTestDatabase, type TestDatabase } from '../../test/db.js';
import { InMemorySecretStore } from '../secrets/store.js';
import { countUsers } from '../auth/users.js';
import { Bootstrap, SetupDisabledError, InvalidSetupTokenError } from './bootstrap.js';
import { createLogger } from '../logger.js';

afterAll(stopTestDatabase);

const log = createLogger('silent');

describe('Bootstrap', () => {
  let db: TestDatabase;
  let store: InMemorySecretStore;
  let bootstrap: Bootstrap;

  beforeEach(async () => {
    db = await freshDatabase();
    store = new InMemorySecretStore();
    bootstrap = new Bootstrap({ db: db.pool, secrets: store, release: 'rel', log });
  });

  it('creates a setup token in the bootstrap secret when there are no users', async () => {
    const token = await bootstrap.ensureToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect((await store.get('rel-bootstrap'))?.token).toBe(token);
  });

  it('reuses an existing token across restarts', async () => {
    const first = await bootstrap.ensureToken();
    const second = await bootstrap.ensureToken();
    expect(second).toBe(first);
  });

  it('creates the first admin and deletes the bootstrap secret', async () => {
    const token = (await bootstrap.ensureToken())!;
    const user = await bootstrap.complete({
      token,
      email: 'Ana@Example.com',
      password: 'hunter2hunter2',
    });
    expect(user.role).toBe('admin');
    expect(user.email).toBe('ana@example.com');
    expect(await countUsers(db.pool)).toBe(1);
    expect(await store.get('rel-bootstrap')).toBeUndefined();
    expect(await bootstrap.isRequired()).toBe(false);
  });

  it('rejects a wrong token', async () => {
    await bootstrap.ensureToken();
    await expect(
      bootstrap.complete({ token: 'nope', email: 'a@b.c', password: 'hunter2hunter2' }),
    ).rejects.toBeInstanceOf(InvalidSetupTokenError);
  });

  it('is disabled once an admin exists', async () => {
    const token = (await bootstrap.ensureToken())!;
    await bootstrap.complete({ token, email: 'a@b.c', password: 'hunter2hunter2' });
    expect(await bootstrap.ensureToken()).toBeUndefined();
    await expect(
      bootstrap.complete({ token, email: 'x@y.z', password: 'hunter2hunter2' }),
    ).rejects.toBeInstanceOf(SetupDisabledError);
  });
});
