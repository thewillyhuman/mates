import type { Mate, TeamManifest } from '@mates/core';
import { mintInvocationToken } from '../auth/invocation-token.js';
import type { Pool } from '../db/pool.js';
import { buildJobManifest, buildTokenSecret, type JobsClient } from '../kubernetes/jobs.js';
import type { Logger } from '../logger.js';
import type { EventBus } from '../runs/bus.js';
import { createInvocation, findInvocation, type Invocation } from '../runs/invocations.js';
import type { HelmConfig } from '../settings/helm.js';
import type { Settings } from '../settings/schema.js';

/**
 * Turns an invocation into a Job (§5.1 item 3). The token Secret is
 * created first, then the Job, then the Secret is parented to the Job so
 * Kubernetes garbage-collects it with the Job.
 */
export interface SpawnerDeps {
  db: Pool;
  bus: EventBus;
  jobs: JobsClient;
  log: Logger;
  internalKey: string;
  release: string;
  namespace: string;
  /** URL runner pods use to reach the API (the Service). */
  apiInternalUrl: string;
  fakeClaude: boolean;
  helm: HelmConfig;
  defaultRunnerImage: string;
  /** Short-lived git token for App-authenticated providers (undefined for PATs). */
  runnerGitToken: (providerId: string) => Promise<string | undefined>;
}

export const JOB_TTL_SECONDS = 3600;

export function tokenSecretName(invocationId: string): string {
  return `mates-inv-${invocationId.replace(/-/g, '').slice(0, 12)}`;
}

export class InvocationSpawner {
  constructor(private readonly deps: SpawnerDeps) {}

  /** Creates the invocation row and its Job. Returns the invocation. */
  async spawn(input: {
    runId: string;
    mate: Mate;
    iteration: number;
    attempt?: number;
    settings: Settings;
    manifest: TeamManifest;
    repoId: string | null;
    scmProviderId: string | null;
  }): Promise<Invocation> {
    const mateSettings = input.settings.mates[input.mate];
    const invocation = await createInvocation(this.deps.db, this.deps.bus, {
      runId: input.runId,
      mate: input.mate,
      iteration: input.iteration,
      model: mateSettings.model,
      attempt: input.attempt ?? 0,
    });
    await this.createJobFor(
      invocation,
      input.settings,
      input.manifest,
      input.repoId,
      input.scmProviderId,
    );
    return invocation;
  }

  /** Creates the Kubernetes objects for an existing invocation row (idempotent). */
  async createJobFor(
    invocation: Invocation,
    settings: Settings,
    manifest: TeamManifest,
    repoId: string | null,
    scmProviderId: string | null,
  ): Promise<void> {
    const mateSettings = settings.mates[invocation.mate];
    const repo = repoId ? manifest.repos.find((r) => r.id === repoId) : undefined;
    const image = repo?.runner_image || settings.runner.image || this.deps.defaultRunnerImage;
    const token = await mintInvocationToken(
      this.deps.internalKey,
      { invocationId: invocation.id, runId: invocation.runId },
      mateSettings.timeout_seconds + 600,
    );
    const secretName = tokenSecretName(invocation.id);
    const appToken = scmProviderId ? await this.deps.runnerGitToken(scmProviderId) : undefined;
    const gitToken = !scmProviderId
      ? null
      : appToken
        ? { secret: secretName, key: 'git_token' }
        : { secret: `${this.deps.release}-credentials`, key: `scm_${scmProviderId}_token` };
    const jobInput = {
      name: invocation.jobName,
      namespace: this.deps.namespace,
      runId: invocation.runId,
      invocationId: invocation.id,
      mate: invocation.mate,
      iteration: invocation.iteration,
      image,
      serviceAccount: this.deps.helm.runner?.serviceAccount ?? `${this.deps.release}-runner`,
      resources: settings.runner.resources,
      timeoutSeconds: mateSettings.timeout_seconds,
      workspaceSizeGi: settings.runner.workspace_size_gi,
      ttlSecondsAfterFinished: JOB_TTL_SECONDS,
      apiUrl: this.deps.apiInternalUrl,
      tokenSecretName: secretName,
      credentialsSecretName: `${this.deps.release}-credentials`,
      gitToken,
      anthropicProvider: settings.anthropic.provider,
      fakeClaude: this.deps.fakeClaude,
      httpProxy: settings.runner.http_proxy,
      noProxy: settings.runner.no_proxy,
      caBundleConfigMap: settings.runner.ca_bundle_configmap,
      imagePullSecret:
        settings.runner.image_pull_secret ||
        this.deps.helm.runner?.imagePullSecrets?.[0]?.name ||
        '',
      extraEnv: {},
    };
    await this.deps.jobs.createSecret(buildTokenSecret(jobInput, token, appToken));
    const { uid } = await this.deps.jobs.createJob(buildJobManifest(jobInput));
    if (uid) {
      await this.deps.jobs
        .setSecretOwner(secretName, invocation.jobName, uid)
        .catch((err: Error) => {
          this.deps.log.warn({ err, secret: secretName }, 'could not parent token secret to job');
        });
    }
    this.deps.log.info(
      { run_id: invocation.runId, invocation_id: invocation.id, job: invocation.jobName, image },
      'job created',
    );
  }

  /** Deletes the Job (and with it the pod and token Secret) of an invocation. */
  async kill(invocationId: string): Promise<void> {
    const inv = await findInvocation(this.deps.db, invocationId);
    if (!inv) return;
    await this.deps.jobs.deleteJob(inv.jobName);
    await this.deps.jobs.deleteSecret(tokenSecretName(inv.id));
  }
}
