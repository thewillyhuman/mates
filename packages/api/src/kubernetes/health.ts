import { VersionApi, type KubeConfig } from '@kubernetes/client-node';

/** Cheapest authenticated call that proves the API server answers. */
export class KubernetesHealth {
  private readonly api: VersionApi;

  constructor(kc: KubeConfig) {
    this.api = kc.makeApiClient(VersionApi);
  }

  async ping(): Promise<void> {
    await this.api.getCode();
  }
}
