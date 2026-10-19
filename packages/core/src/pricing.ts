/**
 * Cost from tokens and a pricing table (§9.1, §9.3). Prices are per
 * million tokens; the table ships empty and operators fill it from
 * Anthropic's current price list.
 */
export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
}

export interface TokenCounts {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

const MTOK = 1_000_000;

/** USD for `tokens` at `price`, rounded to 6 decimals; `null` without a price. */
export function computeCost(tokens: TokenCounts, price: ModelPrice | undefined): number | null {
  if (!price) return null;
  const usd =
    (tokens.input_tokens * price.input_per_mtok +
      tokens.output_tokens * price.output_per_mtok +
      tokens.cache_read_tokens * price.cache_read_per_mtok +
      tokens.cache_write_tokens * price.cache_write_per_mtok) /
    MTOK;
  return Math.round(usd * 1e6) / 1e6;
}

/** The §9.1 flag: reported and computed differ by more than `threshold` (default 10 %). */
export function costDiscrepancy(
  reported: number | null,
  computed: number | null,
  threshold = 0.1,
): { flagged: boolean; ratio: number | null } {
  if (reported === null || computed === null) return { flagged: false, ratio: null };
  const base = Math.max(reported, computed);
  if (base === 0) return { flagged: false, ratio: 0 };
  const ratio = Math.abs(reported - computed) / base;
  return { flagged: ratio > threshold, ratio: Math.round(ratio * 1000) / 1000 };
}
