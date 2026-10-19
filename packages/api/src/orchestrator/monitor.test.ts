import { describe, expect, it } from 'vitest';
import { classifyFailure } from './monitor.js';

const job = (over: Partial<Parameters<typeof classifyFailure>[0]> = {}) => ({
  name: 'j',
  invocationId: 'i',
  runId: 'r',
  active: 0,
  succeeded: 0,
  failed: 1,
  failureReason: 'BackoffLimitExceeded',
  failureMessage: 'Job has reached the specified backoff limit',
  startedAt: null,
  completedAt: null,
  createdAt: null,
  ...over,
});
const pod = (over: Partial<Parameters<typeof classifyFailure>[1][number]> = {}) => ({
  name: 'p',
  phase: 'Failed',
  reason: null,
  waitingReason: null,
  exitCode: null,
  terminatedReason: null,
  ...over,
});

describe('classifyFailure', () => {
  it('maps job and pod states to §7.5 infra reasons', () => {
    expect(classifyFailure(job({ failureReason: 'DeadlineExceeded' }), [])).toMatchObject({
      reason: 'timed_out',
    });
    expect(classifyFailure(job(), [pod({ reason: 'Evicted' })])).toMatchObject({
      reason: 'evicted',
    });
    expect(classifyFailure(job(), [pod({ waitingReason: 'ImagePullBackOff' })])).toMatchObject({
      reason: 'image_pull',
    });
    expect(classifyFailure(job(), [pod({ terminatedReason: 'OOMKilled' })])).toMatchObject({
      reason: 'pod_failed',
      detail: 'pod p OOMKilled',
    });
    expect(classifyFailure(job(), [pod({ exitCode: 1 })])).toEqual({
      reason: 'pod_failed',
      detail: 'BackoffLimitExceeded: Job has reached the specified backoff limit (exit 1)',
    });
  });
});
