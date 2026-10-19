import { z } from 'zod';
import { reviewItemSchema } from './events.js';

/** Structured outputs of the intake and reviewer mates (§7.4). */
export const intakeOutputSchema = z.object({
  decision: z.enum(['implementable', 'needs_clarification', 'out_of_scope']),
  repo_id: z.string().nullable(),
  base_branch: z.string().nullable(),
  plan: z.array(z.string()),
  questions: z.array(z.string()),
  reasoning_summary: z.string().max(600),
});
export type IntakeOutput = z.infer<typeof intakeOutputSchema>;

export const verdictOutputSchema = z.object({
  decision: z.enum(['approve', 'changes_requested']),
  blocking: z.array(reviewItemSchema),
  non_blocking: z.array(reviewItemSchema),
  verified: z.object({
    tests_run: z.boolean(),
    acceptance_criteria: z.array(z.object({ text: z.string(), met: z.boolean() })),
  }),
  summary: z.string().max(800),
});
export type VerdictOutput = z.infer<typeof verdictOutputSchema>;

/** The implementer's closing JSON block (§7.4). */
export const addressedBlockSchema = z.object({
  addressed: z.array(z.string()).default([]),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
  summary: z.string().default(''),
});
export type AddressedBlock = z.infer<typeof addressedBlockSchema>;

/** JSON Schema documents handed to `claude --json-schema`. */
export function intakeJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(intakeOutputSchema) as Record<string, unknown>;
}
export function verdictJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(verdictOutputSchema) as Record<string, unknown>;
}
