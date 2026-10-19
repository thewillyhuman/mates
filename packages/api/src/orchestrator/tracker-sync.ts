import type { NewEvent, RunProjection, Stage } from '@mates/core';
import type { Integrations } from '../integrations.js';
import type { Logger } from '../logger.js';
import type { Settings } from '../settings/schema.js';
import type { CommentKind, Tracker } from '../tracker/tracker.js';

/**
 * Jira side effects (§8.1, §9.5): status transitions from the status map
 * at each stage, and comments on clarification, readiness, cap and failure.
 * Every effect returns the events to append; nothing here touches the log.
 */
export interface TrackerSyncDeps {
  integrations: Integrations;
  log: Logger;
  publicUrl: string;
}

function statusFor(stage: Stage, map: Settings['jira']['status_map']): string {
  switch (stage) {
    case 'intake':
      return map.intake;
    case 'implementing':
    case 'reviewing':
      return map.in_progress;
    case 'mr_ready':
    case 'done':
      return map.mr_ready;
    case 'blocked':
      return map.blocked;
    default:
      return '';
  }
}

export class TrackerSync {
  constructor(private readonly deps: TrackerSyncDeps) {}

  private runLink(runId: string): string {
    return `${this.deps.publicUrl}/runs/${runId}`;
  }

  private async tracker(): Promise<Tracker | undefined> {
    return this.deps.integrations.tracker();
  }

  /** Transition the ticket for a new stage; returns `tracker.transitioned` or `tracker.transition_skipped`. */
  async onStage(
    ticketKey: string,
    stage: Stage,
    settings: Settings,
    current: string | null,
  ): Promise<NewEvent[]> {
    const to = statusFor(stage, settings.jira.status_map);
    if (!to || to === current) return [];
    const tracker = await this.tracker();
    if (!tracker) return [];
    try {
      const r = await tracker.transition(ticketKey, to);
      if (r.ok) return [{ type: 'tracker.transitioned', payload: { from: r.from, to: r.to } }];
      this.deps.log.warn(
        { ticket_key: ticketKey, to, reason: r.reason },
        'jira transition skipped',
      );
      return [
        { type: 'tracker.transition_skipped', payload: { to, reason: r.reason ?? 'unavailable' } },
      ];
    } catch (err) {
      this.deps.log.warn({ err, ticket_key: ticketKey, to }, 'jira transition failed');
      return [
        { type: 'tracker.transition_skipped', payload: { to, reason: (err as Error).message } },
      ];
    }
  }

  /** Posts a comment with the prefix and the run link; returns `tracker.commented` (or nothing). */
  async comment(
    ticketKey: string,
    runId: string,
    text: string,
    kind: CommentKind,
    settings: Settings,
  ): Promise<{ events: NewEvent[]; commentId: string | null }> {
    const enabled =
      kind === 'clarification'
        ? settings.jira.comments.clarification
        : kind === 'nudge_echo'
          ? true
          : settings.jira.comments.status;
    const tracker = await this.tracker();
    if (!enabled || !tracker) return { events: [], commentId: null };
    const body = `${settings.jira.comment_prefix} ${text}\n\n[Open the run in Mates](${this.runLink(runId)})`;
    try {
      const { id } = await tracker.comment(ticketKey, body, kind);
      return {
        events: [{ type: 'tracker.commented', payload: { comment_id: id, kind } }],
        commentId: id,
      };
    } catch (err) {
      this.deps.log.warn({ err, ticket_key: ticketKey, kind }, 'jira comment failed');
      return { events: [], commentId: null };
    }
  }

  /** The "Cost: $X · N iterations · model(s)" suffix of §9.5, when enabled. */
  costLine(p: RunProjection, settings: Settings): string {
    if (!settings.jira.comments.cost) return '';
    const models = [...new Set(p.invocations.map((i) => i.model))].join(', ');
    return ` Cost: $${p.usage.costUsd.toFixed(2)} · ${p.iteration} iteration${p.iteration === 1 ? '' : 's'} · ${models || 'no model'}`;
  }
}
