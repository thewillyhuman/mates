import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDatabase, stopTestDatabase, type TestDatabase } from '../../test/db.js';
import { InMemorySecretStore } from '../secrets/store.js';
import {
  CredentialStore,
  CredentialsReadOnlyError,
  InvalidCredentialNameError,
} from './credentials.js';

afterAll(stopTestDatabase);

describe('CredentialStore', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await freshDatabase();
  });

  it('stores values in the release secret and only metadata in the database', async () => {
    const secrets = new InMemorySecretStore();
    const store = new CredentialStore(secrets, db.pool, 'rel', false);
    expect(await store.status('jira_token')).toMatchObject({
      set: false,
      set_at: null,
      last_validated_at: null,
    });

    await store.set('jira_token', 'abc', 'ana');
    expect((await secrets.get('rel-credentials'))?.jira_token).toBe('abc');
    expect(await store.read('jira_token')).toBe('abc');
    const status = await store.status('jira_token');
    expect(status.set).toBe(true);
    expect(status.set_at).not.toBeNull();

    const rows = await db.pool.query<{ value: unknown }>('SELECT value FROM settings');
    expect(JSON.stringify(rows.rows)).not.toContain('abc');

    await store.markValidated('jira_token');
    expect((await store.status('jira_token')).last_validated_at).not.toBeNull();

    await store.delete('jira_token', 'ana');
    expect(await store.read('jira_token')).toBeUndefined();
    expect((await store.status('jira_token')).set).toBe(false);
  });

  it('accepts scm_<id>_token names and rejects anything else', async () => {
    const store = new CredentialStore(new InMemorySecretStore(), db.pool, 'rel', false);
    await store.set('scm_gitlab-prod_token', 'x', 'ana');
    expect((await store.status('scm_gitlab-prod_token')).set).toBe(true);
    await expect(store.set('ssh_key', 'x', 'ana')).rejects.toBeInstanceOf(
      InvalidCredentialNameError,
    );
    await expect(store.read('../etc/passwd')).rejects.toBeInstanceOf(InvalidCredentialNameError);
  });

  it('is read-only with an existing secret', async () => {
    const secrets = new InMemorySecretStore();
    await secrets.set('rel-credentials', { anthropic_api_key: 'from-eso' });
    const store = new CredentialStore(secrets, db.pool, 'rel', true);
    expect(await store.read('anthropic_api_key')).toBe('from-eso');
    await expect(store.set('anthropic_api_key', 'y', 'ana')).rejects.toBeInstanceOf(
      CredentialsReadOnlyError,
    );
  });
});
