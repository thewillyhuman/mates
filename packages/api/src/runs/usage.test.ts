import { describe, expect, it } from 'vitest';
import { usageRowsFromResult } from './usage.js';

const pricing = {
  'claude-opus-5-5': {
    input_per_mtok: 15,
    output_per_mtok: 75,
    cache_read_per_mtok: 1.5,
    cache_write_per_mtok: 18.75,
  },
};
const inv = { id: 'inv', runId: 'run', model: 'claude-opus-5-5' };

describe('usageRowsFromResult', () => {
  it('uses the per-model breakdown when present, with computed cost for priced models', () => {
    const rows = usageRowsFromResult(
      inv,
      {
        total_cost_usd: 2.5,
        modelUsage: {
          'claude-opus-5-5': {
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 2.0,
          },
          'claude-haiku-5-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.5 },
        },
      },
      pricing,
    );
    expect(rows).toEqual([
      {
        invocationId: 'inv',
        runId: 'run',
        model: 'claude-opus-5-5',
        tokens: {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        },
        costReported: 2.0,
        costComputed: 15,
      },
      {
        invocationId: 'inv',
        runId: 'run',
        model: 'claude-haiku-5-5',
        tokens: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0 },
        costReported: 0.5,
        costComputed: null,
      },
    ]);
  });

  it('falls back to the top-level usage and the invocation model', () => {
    const rows = usageRowsFromResult(
      inv,
      {
        total_cost_usd: 1.1,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
      },
      {},
    );
    expect(rows).toEqual([
      {
        invocationId: 'inv',
        runId: 'run',
        model: 'claude-opus-5-5',
        tokens: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 20,
          cache_write_tokens: 10,
        },
        costReported: 1.1,
        costComputed: null,
      },
    ]);
  });
});
