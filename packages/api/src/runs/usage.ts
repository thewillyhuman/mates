import { computeCost, type ClaudeResult, type ModelPrice, type TokenCounts } from '@mates/core';
import type { Queryable } from '../db/pool.js';

/**
 * The usage ledger (§9.1): one row per invocation and model, with the
 * cost Claude Code reported and the cost computed from the pricing table
 * (null while the model is unpriced).
 */
export interface UsageRowInput {
  invocationId: string;
  runId: string;
  model: string;
  tokens: TokenCounts;
  costReported: number | null;
  costComputed: number | null;
}

export async function insertUsage(db: Queryable, row: UsageRowInput): Promise<void> {
  await db.query(
    `INSERT INTO usage (invocation_id, run_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       cost_usd_reported, cost_usd_computed, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'claude_code_result')`,
    [
      row.invocationId,
      row.runId,
      row.model,
      row.tokens.input_tokens,
      row.tokens.output_tokens,
      row.tokens.cache_read_tokens,
      row.tokens.cache_write_tokens,
      row.costReported,
      row.costComputed,
    ],
  );
}

/**
 * Ledger rows for a final `result`: the per-model breakdown when Claude
 * Code provides one, otherwise one row for the invocation's model.
 */
export function usageRowsFromResult(
  invocation: { id: string; runId: string; model: string },
  result: ClaudeResult,
  pricing: Readonly<Record<string, ModelPrice>>,
): UsageRowInput[] {
  const perModel = result.modelUsage ? Object.entries(result.modelUsage) : [];
  if (perModel.length > 0) {
    return perModel.map(([model, u]) => {
      const tokens: TokenCounts = {
        input_tokens: u.inputTokens ?? 0,
        output_tokens: u.outputTokens ?? 0,
        cache_read_tokens: u.cacheReadInputTokens ?? 0,
        cache_write_tokens: u.cacheCreationInputTokens ?? 0,
      };
      return {
        invocationId: invocation.id,
        runId: invocation.runId,
        model,
        tokens,
        costReported: u.costUSD ?? (perModel.length === 1 ? (result.total_cost_usd ?? null) : null),
        costComputed: computeCost(tokens, pricing[model]),
      };
    });
  }
  const u = result.usage ?? {};
  const tokens: TokenCounts = {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_write_tokens: u.cache_creation_input_tokens ?? 0,
  };
  return [
    {
      invocationId: invocation.id,
      runId: invocation.runId,
      model: invocation.model,
      tokens,
      costReported: result.total_cost_usd ?? null,
      costComputed: computeCost(tokens, pricing[invocation.model]),
    },
  ];
}
