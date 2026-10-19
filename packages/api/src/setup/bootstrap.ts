import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import type { Logger } from '../logger.js';
import type { SecretStore } from '../secrets/store.js';
import { hashPassword } from '../auth/password.js';
import { countUsers, createUser, type User } from '../auth/users.js';

/**
 * First-run setup (§6.1). While no user exists, a one-time setup token lives
 * in the `<release>-bootstrap` Secret so an operator can read it with
 * `kubectl`. Completing setup creates the first admin and removes the token.
 */
export class SetupDisabledError extends Error {
  constructor() {
    super('setup is disabled: an admin already exists');
  }
}

export class InvalidSetupTokenError extends Error {
  constructor() {
    super('invalid setup token');
  }
}

export interface BootstrapDeps {
  readonly db: Pool;
  readonly secrets: SecretStore;
  readonly release: string;
  readonly log: Logger;
}

export class Bootstrap {
  private token: string | undefined;
  private announced = false;

  constructor(private readonly deps: BootstrapDeps) {}

  private get secretName(): string {
    return `${this.deps.release}-bootstrap`;
  }

  async isRequired(): Promise<boolean> {
    return (await countUsers(this.deps.db)) === 0;
  }

  /**
   * Makes sure a setup token exists while setup is required. Logs it once.
   * Returns `undefined` once an admin exists.
   */
  async ensureToken(): Promise<string | undefined> {
    if (!(await this.isRequired())) {
      this.token = undefined;
      return undefined;
    }
    if (this.token) return this.token;
    const existing = (await this.deps.secrets.get(this.secretName))?.token;
    this.token = existing ?? randomBytes(32).toString('base64url');
    if (!existing) await this.deps.secrets.set(this.secretName, { token: this.token });
    if (!this.announced) {
      this.announced = true;
      this.deps.log.warn(
        { setup_token: this.token, secret: this.secretName },
        'no users yet: open /setup and enter the setup token',
      );
    }
    return this.token;
  }

  async complete(input: { token: string; email: string; password: string }): Promise<User> {
    const expected = await this.ensureToken();
    if (expected === undefined) throw new SetupDisabledError();
    if (!constantTimeEquals(input.token, expected)) throw new InvalidSetupTokenError();
    const passwordHash = await hashPassword(input.password);
    const user = await createUser(this.deps.db, {
      email: input.email,
      displayName: input.email.split('@')[0] ?? input.email,
      role: 'admin',
      auth: 'local',
      passwordHash,
    });
    await this.deps.secrets.delete(this.secretName);
    this.token = undefined;
    this.deps.log.info({ user_id: user.id }, 'first admin created; setup disabled');
    return user;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
