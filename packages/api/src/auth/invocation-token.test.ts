import { describe, expect, it } from 'vitest';
import {
  InvalidInvocationTokenError,
  mintInvocationToken,
  verifyInvocationToken,
} from './invocation-token.js';

const key = 'k'.repeat(32);

describe('invocation tokens', () => {
  it('round-trips the invocation and run ids', async () => {
    const token = await mintInvocationToken(key, { invocationId: 'inv-1', runId: 'run-1' }, 60);
    expect(await verifyInvocationToken(key, token)).toEqual({
      invocationId: 'inv-1',
      runId: 'run-1',
    });
  });

  it('rejects a token signed with another key', async () => {
    const token = await mintInvocationToken('x'.repeat(32), { invocationId: 'i', runId: 'r' }, 60);
    await expect(verifyInvocationToken(key, token)).rejects.toBeInstanceOf(
      InvalidInvocationTokenError,
    );
  });

  it('rejects an expired token', async () => {
    const token = await mintInvocationToken(key, { invocationId: 'i', runId: 'r' }, -10);
    await expect(verifyInvocationToken(key, token)).rejects.toThrow(/exp/);
  });

  it('rejects garbage', async () => {
    await expect(verifyInvocationToken(key, 'nope')).rejects.toBeInstanceOf(
      InvalidInvocationTokenError,
    );
  });
});
