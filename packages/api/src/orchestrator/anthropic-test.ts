import type { V1Job } from '@kubernetes/client-node';
import { randomBytes } from 'node:crypto';
import { RUNNER_LABEL, RUNNER_LABEL_VALUE, type JobsClient } from '../kubernetes/jobs.js';
import type { Logger } from '../logger.js';

/**
 * The Anthropic "Test" of §6.2 step 1: a short-lived Job runs a minimal
 * `claude -p` with the stored credential and reports model, latency and
 * cost from its JSON result. Uses the runner image and the runner's
 * security context; nothing but the API key reaches the pod.
 */
export interface AnthropicTestDeps {
  jobs: JobsClient;
  log: Logger;
  namespace: string;
  release: string;
  image: string;
  serviceAccount: string;
  fakeClaude: boolean;
  timeoutMs?: number;
  pollMs?: number;
}

export interface AnthropicTestResult {
  ok: boolean;
  message: string;
  details: { model?: string; latency_ms?: number; cost_usd?: number; job?: string };
}

export function buildTestJob(input: {
  name: string;
  namespace: string;
  image: string;
  serviceAccount: string;
  credentialsSecretName: string;
}): V1Job {
  const labels = { [RUNNER_LABEL]: RUNNER_LABEL_VALUE, 'mates/purpose': 'anthropic-test' };
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: input.name, namespace: input.namespace, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      activeDeadlineSeconds: 120,
      template: {
        metadata: { labels },
        spec: {
          serviceAccountName: input.serviceAccount,
          automountServiceAccountToken: false,
          restartPolicy: 'Never',
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
              command: [
                'claude',
                '--bare',
                '-p',
                'Reply with the single word OK.',
                '--output-format',
                'json',
                '--max-turns',
                '1',
                '--permission-mode',
                'dontAsk',
                '--permission-prompts',
                'none',
              ],
              env: [
                { name: 'HOME', value: '/home/mate' },
                {
                  name: 'ANTHROPIC_API_KEY',
                  valueFrom: {
                    secretKeyRef: { name: input.credentialsSecretName, key: 'anthropic_api_key' },
                  },
                },
              ],
              resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '1', memory: '1Gi' },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'home', mountPath: '/home/mate' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'home', emptyDir: {} },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}

/** Parses the `--output-format json` result: the last JSON object in the logs. */
export function parseTestOutput(logs: string): AnthropicTestResult {
  const lines = logs.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const v = JSON.parse(line) as {
        is_error?: boolean;
        result?: string;
        total_cost_usd?: number;
        duration_ms?: number;
        duration_api_ms?: number;
        modelUsage?: Record<string, unknown>;
      };
      if (v && typeof v === 'object' && 'result' in v) {
        const model = v.modelUsage ? Object.keys(v.modelUsage)[0] : undefined;
        const details: AnthropicTestResult['details'] = {};
        if (model) details.model = model;
        const latency = v.duration_api_ms ?? v.duration_ms;
        if (latency) details.latency_ms = latency;
        if (v.total_cost_usd !== undefined) details.cost_usd = v.total_cost_usd;
        if (v.is_error) {
          return {
            ok: false,
            message: `claude returned an error: ${(v.result ?? '').slice(0, 300)}`,
            details,
          };
        }
        return {
          ok: true,
          message: `claude answered${model ? ` with ${model}` : ''}${latency ? ` in ${latency} ms` : ''}`,
          details,
        };
      }
    } catch {
      // not JSON; keep looking
    }
  }
  return {
    ok: false,
    message: `no result in the job output: ${logs.trim().slice(-300) || '(empty)'}`,
    details: {},
  };
}

export class AnthropicTest {
  constructor(private readonly deps: AnthropicTestDeps) {}

  async run(): Promise<AnthropicTestResult> {
    if (this.deps.fakeClaude) {
      return {
        ok: true,
        message: 'fake-Claude mode: no API call was made',
        details: { model: 'fake', latency_ms: 0, cost_usd: 0 },
      };
    }
    const name = `mates-test-${randomBytes(4).toString('hex')}`;
    await this.deps.jobs.createJob(
      buildTestJob({
        name,
        namespace: this.deps.namespace,
        image: this.deps.image,
        serviceAccount: this.deps.serviceAccount,
        credentialsSecretName: `${this.deps.release}-credentials`,
      }),
    );
    const deadline = Date.now() + (this.deps.timeoutMs ?? 120_000);
    try {
      while (Date.now() < deadline) {
        const job = (await this.deps.jobs.listJobs()).find((j) => j.name === name);
        if (job && (job.succeeded > 0 || job.failed > 0)) {
          const result = parseTestOutput(await this.deps.jobs.podLogs(name));
          result.details.job = name;
          if (job.failed > 0 && result.ok) {
            return { ...result, ok: false, message: `job failed: ${job.failureMessage ?? ''}` };
          }
          return result;
        }
        await new Promise((r) => setTimeout(r, this.deps.pollMs ?? 2000));
      }
      return { ok: false, message: 'the test job did not finish in time', details: { job: name } };
    } finally {
      await this.deps.jobs
        .deleteJob(name)
        .catch((err: Error) => this.deps.log.warn({ err, job: name }, 'could not delete test job'));
    }
  }
}
