import type { Pool } from '../db/pool.js';
import type { SecretStore } from '../secrets/store.js';

/**
 * Credentials live in the `<release>-credentials` Secret (§10.2). The
 * database keeps only metadata: when a value was set and last validated.
 * With `credentials.existingSecret` the store is read-only for the UI.
 */
export const CREDENTIAL_NAME =
  /^(anthropic_api_key|jira_token|jira_webhook_secret|oidc_client_secret|scm_[a-z0-9-]+_(token|app_private_key))$/;

export interface CredentialStatus {
  name: string;
  set: boolean;
  set_at: string | null;
  last_validated_at: string | null;
}

export class CredentialsReadOnlyError extends Error {
  constructor() {
    super('credentials are managed by an existing Secret and cannot be changed from the UI');
  }
}

export class InvalidCredentialNameError extends Error {
  constructor(name: string) {
    super(`unknown credential "${name}"`);
  }
}

interface Meta {
  set_at?: string;
  last_validated_at?: string;
}

const META_KEY = 'credentials_meta';

export class CredentialStore {
  constructor(
    private readonly secrets: SecretStore,
    private readonly db: Pool,
    private readonly release: string,
    readonly readOnly: boolean,
  ) {}

  get secretName(): string {
    return `${this.release}-credentials`;
  }

  private assertName(name: string): void {
    if (!CREDENTIAL_NAME.test(name)) throw new InvalidCredentialNameError(name);
  }

  /** The secret value, for the API's own adapter calls. Never returned over HTTP. */
  async read(name: string): Promise<string | undefined> {
    this.assertName(name);
    const value = (await this.secrets.get(this.secretName))?.[name];
    return value ? value : undefined;
  }

  async set(name: string, value: string, by: string): Promise<void> {
    this.assertName(name);
    if (this.readOnly) throw new CredentialsReadOnlyError();
    if (!value) throw new Error('credential value must not be empty');
    await this.secrets.patch(this.secretName, { [name]: value });
    await this.updateMeta(name, { set_at: new Date().toISOString() }, by);
  }

  async delete(name: string, by: string): Promise<void> {
    this.assertName(name);
    if (this.readOnly) throw new CredentialsReadOnlyError();
    await this.secrets.patch(this.secretName, { [name]: null });
    await this.db.query(
      `UPDATE settings SET value = value - $1, updated_at = now(), updated_by = $2 WHERE key = $3`,
      [name, by, META_KEY],
    );
  }

  async markValidated(name: string): Promise<void> {
    this.assertName(name);
    await this.updateMeta(name, { last_validated_at: new Date().toISOString() }, 'system');
  }

  async status(name: string): Promise<CredentialStatus> {
    this.assertName(name);
    const [value, meta] = await Promise.all([this.read(name), this.readMeta()]);
    const m = meta[name] ?? {};
    return {
      name,
      set: value !== undefined,
      set_at: m.set_at ?? null,
      last_validated_at: m.last_validated_at ?? null,
    };
  }

  private async readMeta(): Promise<Record<string, Meta>> {
    const r = await this.db.query<{ value: Record<string, Meta> }>(
      'SELECT value FROM settings WHERE key = $1',
      [META_KEY],
    );
    return r.rows[0]?.value ?? {};
  }

  private async updateMeta(name: string, patch: Meta, by: string): Promise<void> {
    const meta = await this.readMeta();
    meta[name] = { ...meta[name], ...patch };
    await this.db.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [META_KEY, JSON.stringify(meta), by],
    );
  }
}
