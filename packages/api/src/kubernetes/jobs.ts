import type { Mate } from '@mates/core';
import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  type KubeConfig,
  type V1Job,
  type V1Pod,
  type V1Secret,
} from '@kubernetes/client-node';

/**
 * Runner Jobs (§7.2). `buildJobManifest` is pure so the security context
 * and environment can be asserted in tests; `KubernetesJobsClient` is the
 * thin layer over the API server, and `JobsClient` the seam for tests.
 */
export const RUNNER_LABEL = 'app.kubernetes.io/name';
export const RUNNER_LABEL_VALUE = 'mates-runner';
export const LABEL_RUN = 'mates/run';
export const LABEL_INVOCATION = 'mates/invocation';
export const LABEL_MATE = 'mates/mate';
export const LABEL_ITERATION = 'mates/iteration';

export interface JobInput {
  name: string;
  namespace: string;
  runId: string;
  invocationId: string;
  mate: Mate;
  iteration: number;
  image: string;
  serviceAccount: string;
  resources: { requests: { cpu: string; memory: string }; limits: { cpu: string; memory: string } };
  timeoutSeconds: number;
  workspaceSizeGi: number;
  ttlSecondsAfterFinished: number;
  apiUrl: string;
  /** Secret holding MATES_INVOCATION_TOKEN; created with the Job. */
  tokenSecretName: string;
  credentialsSecretName: string;
  /** Where GIT_TOKEN comes from: the credentials Secret (PAT) or the token Secret (App). */
  gitToken: { secret: string; key: string } | null;
  anthropicProvider: 'api_key' | 'bedrock' | 'vertex' | 'foundry';
  fakeClaude: boolean;
  httpProxy: string;
  noProxy: string;
  caBundleConfigMap: string;
  imagePullSecret: string;
  extraEnv: Record<string, string>;
}

function env(name: string, value: string) {
  return { name, value };
}
function secretEnv(name: string, secret: string, key: string, optional = false) {
  return { name, valueFrom: { secretKeyRef: { name: secret, key, optional } } };
}

/** The Job of §7.2, verbatim where the spec is explicit. */
export function buildJobManifest(input: JobInput): V1Job {
  const labels = {
    [RUNNER_LABEL]: RUNNER_LABEL_VALUE,
    [LABEL_RUN]: input.runId,
    [LABEL_INVOCATION]: input.invocationId,
    [LABEL_MATE]: input.mate,
    [LABEL_ITERATION]: String(input.iteration),
  };
  const envVars = [
    env('MATES_API_URL', input.apiUrl),
    secretEnv('MATES_INVOCATION_TOKEN', input.tokenSecretName, 'token'),
    env('MATES_INVOCATION_ID', input.invocationId),
    env('MATES_RUN_ID', input.runId),
    env('MATES_MATE', input.mate),
    env('MATES_ITERATION', String(input.iteration)),
    env('HOME', '/home/mate'),
  ];
  if (input.anthropicProvider === 'api_key') {
    envVars.push(
      secretEnv('ANTHROPIC_API_KEY', input.credentialsSecretName, 'anthropic_api_key', true),
    );
  }
  if (input.gitToken)
    envVars.push(secretEnv('GIT_TOKEN', input.gitToken.secret, input.gitToken.key, true));
  if (input.fakeClaude) envVars.push(env('MATES_FAKE_CLAUDE', '1'));
  if (input.httpProxy) {
    envVars.push(
      env('HTTPS_PROXY', input.httpProxy),
      env('HTTP_PROXY', input.httpProxy),
      env('https_proxy', input.httpProxy),
    );
  }
  if (input.noProxy) envVars.push(env('NO_PROXY', input.noProxy), env('no_proxy', input.noProxy));
  if (input.caBundleConfigMap) {
    envVars.push(
      env('NODE_EXTRA_CA_CERTS', '/etc/mates/ca/ca.crt'),
      env('GIT_SSL_CAINFO', '/etc/mates/ca/ca.crt'),
      env('SSL_CERT_FILE', '/etc/mates/ca/ca.crt'),
    );
  }
  for (const [k, v] of Object.entries(input.extraEnv)) envVars.push(env(k, v));

  const volumeMounts = [
    { name: 'workspace', mountPath: '/workspace' },
    { name: 'home', mountPath: '/home/mate' },
    { name: 'tmp', mountPath: '/tmp' },
    { name: 'context', mountPath: '/context' },
  ];
  const volumes: NonNullable<V1Pod['spec']>['volumes'] = [
    { name: 'workspace', emptyDir: { sizeLimit: `${input.workspaceSizeGi}Gi` } },
    { name: 'home', emptyDir: {} },
    { name: 'tmp', emptyDir: {} },
    { name: 'context', emptyDir: { sizeLimit: '256Mi' } },
  ];
  if (input.caBundleConfigMap) {
    volumeMounts.push({ name: 'ca', mountPath: '/etc/mates/ca' });
    volumes.push({ name: 'ca', configMap: { name: input.caBundleConfigMap } });
  }

  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.name, namespace: input.namespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished,
      activeDeadlineSeconds: input.timeoutSeconds + 120,
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: input.serviceAccount,
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
          ...(input.imagePullSecret ? { imagePullSecrets: [{ name: input.imagePullSecret }] } : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'runner',
              image: input.image,
              command: ['mates-run'],
              env: envVars,
              resources: input.resources,
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts,
            },
          ],
          volumes,
        },
      },
    },
  };
}

/** The per-invocation Secret holding the JWT; owned by the Job so it is garbage-collected with it. */
export function buildTokenSecret(
  input: Pick<JobInput, 'tokenSecretName' | 'namespace' | 'runId' | 'invocationId'>,
  token: string,
  /** An installation token minted for this invocation (GitHub App providers). */
  gitToken?: string,
): V1Secret {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: input.tokenSecretName,
      namespace: input.namespace,
      labels: {
        [RUNNER_LABEL]: RUNNER_LABEL_VALUE,
        [LABEL_RUN]: input.runId,
        [LABEL_INVOCATION]: input.invocationId,
      },
    },
    type: 'Opaque',
    data: {
      token: Buffer.from(token).toString('base64'),
      ...(gitToken ? { git_token: Buffer.from(gitToken).toString('base64') } : {}),
    },
  };
}

export interface JobView {
  name: string;
  invocationId: string | null;
  runId: string | null;
  active: number;
  succeeded: number;
  failed: number;
  /** `DeadlineExceeded`, `BackoffLimitExceeded`, … from the Failed condition. */
  failureReason: string | null;
  failureMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
}

export interface PodView {
  name: string;
  phase: string;
  reason: string | null;
  /** `ImagePullBackOff`, `ErrImagePull`, `CrashLoopBackOff`, … */
  waitingReason: string | null;
  exitCode: number | null;
  terminatedReason: string | null;
}

export interface JobsClient {
  createJob(job: V1Job): Promise<{ uid: string }>;
  /** Combined logs of the Job's pod(s); empty when none exists yet. */
  podLogs(jobName: string): Promise<string>;
  createSecret(secret: V1Secret, ownerJobUid?: string): Promise<void>;
  setSecretOwner(name: string, jobName: string, jobUid: string): Promise<void>;
  deleteJob(name: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  listJobs(): Promise<JobView[]>;
  listPods(jobName: string): Promise<PodView[]>;
  listTokenSecrets(): Promise<string[]>;
}

export function toJobView(j: V1Job): JobView {
  const failed = j.status?.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
  return {
    name: j.metadata?.name ?? '',
    invocationId: j.metadata?.labels?.[LABEL_INVOCATION] ?? null,
    runId: j.metadata?.labels?.[LABEL_RUN] ?? null,
    active: j.status?.active ?? 0,
    succeeded: j.status?.succeeded ?? 0,
    failed: j.status?.failed ?? 0,
    failureReason: failed?.reason ?? null,
    failureMessage: failed?.message ?? null,
    startedAt: j.status?.startTime ?? null,
    completedAt: j.status?.completionTime ?? null,
    createdAt: j.metadata?.creationTimestamp ?? null,
  };
}

export function toPodView(p: V1Pod): PodView {
  const c = p.status?.containerStatuses?.[0];
  return {
    name: p.metadata?.name ?? '',
    phase: p.status?.phase ?? 'Unknown',
    reason: p.status?.reason ?? null,
    waitingReason: c?.state?.waiting?.reason ?? null,
    exitCode: c?.state?.terminated?.exitCode ?? null,
    terminatedReason: c?.state?.terminated?.reason ?? null,
  };
}

export class KubernetesJobsClient implements JobsClient {
  private readonly batch: BatchV1Api;
  private readonly core: CoreV1Api;

  constructor(
    kc: KubeConfig,
    private readonly namespace: string,
  ) {
    this.batch = kc.makeApiClient(BatchV1Api);
    this.core = kc.makeApiClient(CoreV1Api);
  }

  async createJob(job: V1Job): Promise<{ uid: string }> {
    try {
      const created = await this.batch.createNamespacedJob({
        namespace: this.namespace,
        body: job,
      });
      return { uid: created.metadata?.uid ?? '' };
    } catch (err) {
      if (err instanceof ApiException && err.code === 409) {
        // Idempotent spawn (§3.2): the Job already exists.
        const existing = await this.batch.readNamespacedJob({
          name: job.metadata!.name!,
          namespace: this.namespace,
        });
        return { uid: existing.metadata?.uid ?? '' };
      }
      throw err;
    }
  }

  async createSecret(secret: V1Secret, ownerJobUid?: string): Promise<void> {
    if (ownerJobUid && secret.metadata) {
      secret.metadata.ownerReferences = [
        { apiVersion: 'batch/v1', kind: 'Job', name: secret.metadata.name!, uid: ownerJobUid },
      ];
    }
    try {
      await this.core.createNamespacedSecret({ namespace: this.namespace, body: secret });
    } catch (err) {
      if (err instanceof ApiException && err.code === 409) {
        await this.core.replaceNamespacedSecret({
          name: secret.metadata!.name!,
          namespace: this.namespace,
          body: secret,
        });
        return;
      }
      throw err;
    }
  }

  async setSecretOwner(name: string, jobName: string, jobUid: string): Promise<void> {
    await this.core.patchNamespacedSecret({
      name,
      namespace: this.namespace,
      body: {
        metadata: {
          ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: jobName, uid: jobUid }],
        },
      },
    });
  }

  async deleteJob(name: string): Promise<void> {
    try {
      await this.batch.deleteNamespacedJob({
        name,
        namespace: this.namespace,
        propagationPolicy: 'Background',
      });
    } catch (err) {
      if (!(err instanceof ApiException && err.code === 404)) throw err;
    }
  }

  async deleteSecret(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedSecret({ name, namespace: this.namespace });
    } catch (err) {
      if (!(err instanceof ApiException && err.code === 404)) throw err;
    }
  }

  async listJobs(): Promise<JobView[]> {
    const list = await this.batch.listNamespacedJob({
      namespace: this.namespace,
      labelSelector: `${RUNNER_LABEL}=${RUNNER_LABEL_VALUE}`,
    });
    return list.items.map(toJobView);
  }

  async listPods(jobName: string): Promise<PodView[]> {
    const list = await this.core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
    });
    return list.items.map(toPodView);
  }

  async podLogs(jobName: string): Promise<string> {
    const list = await this.core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
    });
    const chunks: string[] = [];
    for (const pod of list.items) {
      const name = pod.metadata?.name;
      if (!name) continue;
      try {
        chunks.push(
          await this.core.readNamespacedPodLog({
            name,
            namespace: this.namespace,
            container: 'runner',
          }),
        );
      } catch (err) {
        if (!(err instanceof ApiException && (err.code === 400 || err.code === 404))) throw err;
      }
    }
    return chunks.join('\n');
  }

  async listTokenSecrets(): Promise<string[]> {
    const list = await this.core.listNamespacedSecret({
      namespace: this.namespace,
      labelSelector: `${RUNNER_LABEL}=${RUNNER_LABEL_VALUE}`,
    });
    return list.items.map((s) => s.metadata?.name ?? '').filter(Boolean);
  }
}

/** In-memory JobsClient for tests and local development without a cluster. */
export class FakeJobsClient implements JobsClient {
  readonly jobs = new Map<string, V1Job>();
  readonly secrets = new Map<string, V1Secret>();
  readonly deleted: string[] = [];
  /** Test hook: status to report per job name. */
  readonly status = new Map<string, Partial<JobView>>();
  readonly pods = new Map<string, PodView[]>();

  async createJob(job: V1Job): Promise<{ uid: string }> {
    const name = job.metadata!.name!;
    if (!this.jobs.has(name)) this.jobs.set(name, job);
    return { uid: `uid-${name}` };
  }
  async createSecret(secret: V1Secret): Promise<void> {
    this.secrets.set(secret.metadata!.name!, secret);
  }
  async setSecretOwner(): Promise<void> {}
  async deleteJob(name: string): Promise<void> {
    this.jobs.delete(name);
    this.deleted.push(name);
  }
  async deleteSecret(name: string): Promise<void> {
    this.secrets.delete(name);
  }
  async listJobs(): Promise<JobView[]> {
    return [...this.jobs.values()].map((j) => ({
      ...toJobView(j),
      active: 1,
      ...this.status.get(j.metadata!.name!),
    }));
  }
  async listPods(jobName: string): Promise<PodView[]> {
    return this.pods.get(jobName) ?? [];
  }
  async listTokenSecrets(): Promise<string[]> {
    return [...this.secrets.keys()];
  }
  /** Test hook: logs to return per job name. */
  readonly logs = new Map<string, string>();
  async podLogs(jobName: string): Promise<string> {
    return this.logs.get(jobName) ?? '';
  }
}
