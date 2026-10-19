import { BLOCKED_REASONS, STAGES, type RunProjection } from '@mates/core';
import { z } from 'zod';
import type { RunDetail } from './repository.js';

/**
 * Presentation shapes for the API. The board gets a compact summary; the
 * detail page gets the full projection (typed in the UI via @mates/core).
 */
export const ticketSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  projectKey: z.string().nullable(),
  repoId: z.string().nullable(),
});

export const runSummarySchema = z.object({
  id: z.string(),
  ticket: ticketSchema,
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  stage: z.enum(STAGES),
  stageChangedAt: z.string(),
  blockedReason: z.enum(BLOCKED_REASONS).nullable(),
  paused: z.boolean(),
  iteration: z.number(),
  maxIterations: z.number(),
  currentAction: z.string(),
  currentMate: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  mr: z.object({ id: z.string(), url: z.string(), draft: z.boolean() }).nullable(),
  costUsd: z.number(),
  tokens: z.number(),
  lastVerdict: z
    .object({ decision: z.string(), blocking: z.number(), nonBlocking: z.number() })
    .nullable(),
  questions: z.array(z.string()),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runDetailSchema = z.object({
  id: z.string(),
  ticket: ticketSchema,
  branch: z.string().nullable(),
  baseBranch: z.string().nullable(),
  teamContextVersion: z.number().nullable(),
  projection: z.record(z.string(), z.unknown()),
});
export type RunDetailView = z.infer<typeof runDetailSchema>;

function tokens(p: RunProjection): number {
  return (
    p.usage.inputTokens + p.usage.outputTokens + p.usage.cacheReadTokens + p.usage.cacheWriteTokens
  );
}

export function toRunSummary(d: RunDetail): RunSummary {
  const p = d.projection;
  return {
    id: d.run.id,
    ticket: toTicketView(d),
    repo: p.intake?.repo ?? d.ticket.repoId,
    branch: d.run.branch,
    stage: p.stage,
    stageChangedAt: p.stageChangedAt,
    blockedReason: p.blockedReason,
    paused: p.paused,
    iteration: p.iteration,
    maxIterations: p.maxIterations,
    currentAction: p.currentAction,
    currentMate: p.currentInvocation?.mate ?? null,
    createdAt: p.createdAt,
    finishedAt: p.finishedAt,
    mr: p.mr,
    costUsd: p.usage.costUsd,
    tokens: tokens(p),
    lastVerdict: p.lastVerdict
      ? {
          decision: p.lastVerdict.decision,
          blocking: p.lastVerdict.blocking.length,
          nonBlocking: p.lastVerdict.nonBlocking.length,
        }
      : null,
    questions: p.questions,
  };
}

export function toRunDetail(d: RunDetail): RunDetailView {
  return {
    id: d.run.id,
    ticket: toTicketView(d),
    branch: d.run.branch,
    baseBranch: d.run.baseBranch ?? d.projection.intake?.base_branch ?? null,
    teamContextVersion: d.run.teamContextVersion,
    projection: d.projection as unknown as Record<string, unknown>,
  };
}

function toTicketView(d: RunDetail) {
  return {
    id: d.ticket.id,
    key: d.ticket.externalKey,
    title: d.ticket.title,
    url: d.ticket.url,
    projectKey: d.ticket.projectKey,
    repoId: d.ticket.repoId,
  };
}
