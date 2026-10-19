import { describe, expect, it } from 'vitest';
import { computeCost, costDiscrepancy } from './pricing.js';

const price = {
  input_per_mtok: 15,
  output_per_mtok: 75,
  cache_read_per_mtok: 1.5,
  cache_write_per_mtok: 18.75,
};

describe('computeCost', () => {
  it('prices each token kind per million tokens', () => {
    expect(
      computeCost(
        { input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
        price,
      ),
    ).toBe(15);
    expect(
      computeCost(
        {
          input_tokens: 10_000,
          output_tokens: 2_000,
          cache_read_tokens: 100_000,
          cache_write_tokens: 5_000,
        },
        price,
      ),
    ).toBe(
      Math.round(((10_000 * 15 + 2_000 * 75 + 100_000 * 1.5 + 5_000 * 18.75) / 1e6) * 1e6) / 1e6,
    );
  });

  it('is null when the model is not priced', () => {
    expect(
      computeCost(
        { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 },
        undefined,
      ),
    ).toBeNull();
  });
});

describe('costDiscrepancy', () => {
  it('flags differences above ten percent', () => {
    expect(costDiscrepancy(1.0, 1.05)).toEqual({ flagged: false, ratio: 0.048 });
    expect(costDiscrepancy(1.0, 1.2)).toEqual({ flagged: true, ratio: 0.167 });
    expect(costDiscrepancy(0, 0)).toEqual({ flagged: false, ratio: 0 });
  });

  it('cannot flag without both figures', () => {
    expect(costDiscrepancy(null, 1)).toEqual({ flagged: false, ratio: null });
    expect(costDiscrepancy(1, null)).toEqual({ flagged: false, ratio: null });
  });
});
