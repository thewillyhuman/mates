/**
 * Where credentials live (§10.2): a Kubernetes Secret in production, memory
 * for local development and tests. The database never sees a value, only
 * whether one is set.
 */
export type SecretData = Readonly<Record<string, string>>;

export interface SecretStore {
  /** All keys of the named secret, or `undefined` if it does not exist. */
  get(name: string): Promise<SecretData | undefined>;
  /** Creates or fully replaces the named secret. */
  set(name: string, data: SecretData): Promise<void>;
  /** Sets the given keys (null deletes a key); creates the secret if missing. */
  patch(name: string, data: Readonly<Record<string, string | null>>): Promise<void>;
  /** Removes the secret; a missing secret is not an error. */
  delete(name: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  private readonly secrets = new Map<string, Record<string, string>>();

  async get(name: string): Promise<SecretData | undefined> {
    const s = this.secrets.get(name);
    return s ? { ...s } : undefined;
  }

  async set(name: string, data: SecretData): Promise<void> {
    this.secrets.set(name, { ...data });
  }

  async patch(name: string, data: Readonly<Record<string, string | null>>): Promise<void> {
    const current = this.secrets.get(name) ?? {};
    for (const [k, v] of Object.entries(data)) {
      if (v === null) delete current[k];
      else current[k] = v;
    }
    this.secrets.set(name, current);
  }

  async delete(name: string): Promise<void> {
    this.secrets.delete(name);
  }
}
