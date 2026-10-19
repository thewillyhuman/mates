import type { TicketDetails } from './types.js';

/**
 * The tracker port (§8). Jira is the only implementation in v1; the
 * orchestrator and the tests talk to this interface only.
 */
export interface TicketRef {
  key: string;
  id: string;
  summary: string;
  updated: string;
}

export interface Ticket {
  key: string;
  id: string;
  title: string;
  url: string;
  projectKey: string;
  details: TicketDetails;
}

export interface TriggerRule {
  kind: 'assignee' | 'label' | 'status' | 'jql';
  value: string;
}

export type CommentKind = 'clarification' | 'status' | 'nudge_echo';

export interface TransitionResult {
  ok: boolean;
  from: string;
  to: string;
  /** Why no transition happened (status unknown, no path from the current status). */
  reason?: string;
}

/** What a webhook delivery means for Mates. */
export type TrackerEvent =
  | { type: 'issue_updated'; key: string; id: string; matchesRule: boolean }
  | {
      type: 'comment_created';
      key: string;
      id: string;
      commentId: string;
      author: string;
      /** The comment was posted by Mates itself (prefix or account match). */
      authorIsSelf: boolean;
      body: string;
    };

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
}

export interface TrackerTestResult {
  ok: boolean;
  message: string;
  matched: TicketRef[];
}

export interface Tracker {
  listTriggered(rule: TriggerRule): Promise<TicketRef[]>;
  getTicket(key: string): Promise<Ticket>;
  comment(key: string, markdown: string, kind?: CommentKind): Promise<{ id: string }>;
  /** Resolves the transition by target status name; never throws for a missing transition. */
  transition(key: string, toStatusName: string): Promise<TransitionResult>;
  verifyWebhook(req: WebhookRequest): boolean;
  parseWebhook(req: WebhookRequest, rule: TriggerRule): TrackerEvent[];
  /** Validates auth and the rule; returns the tickets it would trigger (§6.2 step 2). */
  test(rule: TriggerRule): Promise<TrackerTestResult>;
}

export class TrackerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
