import { describe, expect, it } from 'vitest';
import { buildJobManifest, buildTokenSecret, toJobView, toPodView, type JobInput } from './jobs.js';

const input: JobInput = {
  name: 'mates-r1234abcd-i2-implementer',
  namespace: 'mates',
  runId: '1234abcd-0000-0000-0000-000000000000',
  invocationId: 'inv-1',
  mate: 'implementer',
  iteration: 2,
  image: 'ghcr.io/x/mates-runner:0.1.0',
  serviceAccount: 'mates-runner',
  resources: { requests: { cpu: '1', memory: '2Gi' }, limits: { cpu: '4', memory: '8Gi' } },
  timeoutSeconds: 2700,
  workspaceSizeGi: 10,
  ttlSecondsAfterFinished: 3600,
  apiUrl: 'http://mates.mates.svc:8080',
  tokenSecretName: 'mates-inv-inv-1',
  credentialsSecretName: 'mates-credentials',
  gitToken: { secret: 'mates-credentials', key: 'scm_gitlab_token' },
  anthropicProvider: 'api_key',
  fakeClaude: false,
  httpProxy: '',
  noProxy: '',
  caBundleConfigMap: '',
  imagePullSecret: '',
  extraEnv: {},
};

describe('buildJobManifest', () => {
  it('matches the §7.2 spec: labels, security, volumes, deadline, env', () => {
    const job = buildJobManifest(input);
    expect(job.metadata?.labels).toEqual({
      'app.kubernetes.io/name': 'mates-runner',
      'mates/run': input.runId,
      'mates/invocation': 'inv-1',
      'mates/mate': 'implementer',
      'mates/iteration': '2',
    });
    expect(job.spec).toMatchObject({
      backoffLimit: 0,
      ttlSecondsAfterFinished: 3600,
      activeDeadlineSeconds: 2820,
    });
    const pod = job.spec!.template.spec!;
    expect(pod).toMatchObject({
      serviceAccountName: 'mates-runner',
      automountServiceAccountToken: false,
      restartPolicy: 'Never',
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
    });
    const c = pod.containers[0]!;
    expect(c.command).toEqual(['mates-run']);
    expect(c.securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(c.resources).toEqual(input.resources);
    expect(c.volumeMounts!.map((m) => m.mountPath)).toEqual([
      '/workspace',
      '/home/mate',
      '/tmp',
      '/context',
    ]);
    expect(pod.volumes!.find((v) => v.name === 'workspace')).toEqual({
      name: 'workspace',
      emptyDir: { sizeLimit: '10Gi' },
    });
    const envNames = c.env!.map((e) => e.name);
    expect(envNames).toEqual(
      expect.arrayContaining([
        'MATES_API_URL',
        'MATES_INVOCATION_TOKEN',
        'MATES_INVOCATION_ID',
        'MATES_RUN_ID',
        'MATES_MATE',
        'MATES_ITERATION',
        'ANTHROPIC_API_KEY',
        'GIT_TOKEN',
      ]),
    );
    expect(
      c.env!.find((e) => e.name === 'MATES_INVOCATION_TOKEN')!.valueFrom!.secretKeyRef,
    ).toEqual({ name: 'mates-inv-inv-1', key: 'token', optional: false });
    expect(c.env!.find((e) => e.name === 'GIT_TOKEN')!.valueFrom!.secretKeyRef).toEqual({
      name: 'mates-credentials',
      key: 'scm_gitlab_token',
      optional: true,
    });
    expect(envNames).not.toContain('MATES_FAKE_CLAUDE');
    expect(JSON.stringify(job)).not.toMatch(/eyJ|token"?:"[A-Za-z0-9]/);
  });

  it('adds proxy, CA bundle, pull secret and fake mode when configured', () => {
    const job = buildJobManifest({
      ...input,
      fakeClaude: true,
      httpProxy: 'http://proxy:3128',
      noProxy: '.svc',
      caBundleConfigMap: 'corp-ca',
      imagePullSecret: 'regcred',
      gitToken: null,
      anthropicProvider: 'bedrock',
    });
    const pod = job.spec!.template.spec!;
    const env = Object.fromEntries(pod.containers[0]!.env!.map((e) => [e.name, e.value ?? 'ref']));
    expect(env).toMatchObject({
      MATES_FAKE_CLAUDE: '1',
      HTTPS_PROXY: 'http://proxy:3128',
      NO_PROXY: '.svc',
      NODE_EXTRA_CA_CERTS: '/etc/mates/ca/ca.crt',
    });
    expect(env).not.toHaveProperty('GIT_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(pod.imagePullSecrets).toEqual([{ name: 'regcred' }]);
    expect(pod.volumes!.find((v) => v.name === 'ca')).toEqual({
      name: 'ca',
      configMap: { name: 'corp-ca' },
    });
  });

  it('builds the token secret with runner labels', () => {
    const s = buildTokenSecret(input, 'jwt-value');
    expect(s.metadata?.labels).toMatchObject({
      'app.kubernetes.io/name': 'mates-runner',
      'mates/invocation': 'inv-1',
    });
    expect(Buffer.from(s.data!.token!, 'base64').toString()).toBe('jwt-value');
  });
});

describe('views', () => {
  it('extracts failure conditions and pod states', () => {
    const job = toJobView({
      metadata: { name: 'j', labels: { 'mates/invocation': 'i', 'mates/run': 'r' } },
      status: {
        failed: 1,
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'DeadlineExceeded',
            message: 'Job was active longer than specified deadline',
          },
        ],
      },
    });
    expect(job).toMatchObject({
      name: 'j',
      invocationId: 'i',
      runId: 'r',
      failed: 1,
      failureReason: 'DeadlineExceeded',
    });
    const pod = toPodView({
      metadata: { name: 'p' },
      status: {
        phase: 'Pending',
        containerStatuses: [
          {
            name: 'runner',
            image: 'x',
            imageID: '',
            ready: false,
            restartCount: 0,
            state: { waiting: { reason: 'ImagePullBackOff' } },
          },
        ],
      },
    });
    expect(pod).toMatchObject({
      phase: 'Pending',
      waitingReason: 'ImagePullBackOff',
      exitCode: null,
    });
  });
});
