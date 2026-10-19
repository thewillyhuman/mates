import { ApiException, CoreV1Api, KubeConfig, type V1Secret } from '@kubernetes/client-node';
import type { SecretData, SecretStore } from './store.js';

/**
 * SecretStore backed by Kubernetes Secrets in one namespace. Values are
 * stored under `data` (base64) as the API requires; callers see plain text.
 */
export class KubernetesSecretStore implements SecretStore {
  private readonly api: CoreV1Api;

  constructor(
    private readonly namespace: string,
    kubeConfig?: KubeConfig,
  ) {
    const kc = kubeConfig ?? loadKubeConfig();
    this.api = kc.makeApiClient(CoreV1Api);
  }

  async get(name: string): Promise<SecretData | undefined> {
    try {
      const secret = await this.api.readNamespacedSecret({ name, namespace: this.namespace });
      return decode(secret);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async set(name: string, data: SecretData): Promise<void> {
    const body: V1Secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name,
        namespace: this.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'mates-api' },
      },
      type: 'Opaque',
      data: encode(data),
    };
    try {
      await this.api.createNamespacedSecret({ namespace: this.namespace, body });
    } catch (err) {
      if (!isConflict(err)) throw err;
      await this.api.replaceNamespacedSecret({ name, namespace: this.namespace, body });
    }
  }

  async patch(name: string, data: Readonly<Record<string, string | null>>): Promise<void> {
    const current = (await this.get(name)) ?? {};
    const next: Record<string, string> = { ...current };
    for (const [k, v] of Object.entries(data)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    await this.set(name, next);
  }

  async delete(name: string): Promise<void> {
    try {
      await this.api.deleteNamespacedSecret({ name, namespace: this.namespace });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

export function loadKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc;
}

function decode(secret: V1Secret): SecretData {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secret.data ?? {})) {
    out[k] = Buffer.from(v, 'base64').toString('utf8');
  }
  return out;
}

function encode(data: SecretData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) out[k] = Buffer.from(v, 'utf8').toString('base64');
  return out;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiException && err.code === 404;
}

function isConflict(err: unknown): boolean {
  return err instanceof ApiException && err.code === 409;
}
