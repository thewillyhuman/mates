import { emptyTicketDetails } from './types.js';
import type {
  CommentKind,
  Ticket,
  TicketRef,
  Tracker,
  TrackerEvent,
  TrackerTestResult,
  TransitionResult,
  WebhookRequest,
} from './tracker.js';

/** In-memory tracker for orchestrator tests and local development. */
export class FakeTracker implements Tracker {
  readonly tickets = new Map<string, Ticket>();
  readonly comments: { key: string; markdown: string; kind: CommentKind | undefined }[] = [];
  readonly transitions: { key: string; to: string }[] = [];
  triggered: TicketRef[] = [];
  /** Transitions `transition()` refuses, by target status name. */
  readonly unavailableTransitions = new Set<string>();
  webhookSecret = 'fake-secret';

  seed(key: string, title: string, details: Partial<Ticket['details']> = {}): Ticket {
    const ticket: Ticket = {
      key,
      id: `id-${key}`,
      title,
      url: `https://jira.example.com/browse/${key}`,
      projectKey: key.split('-')[0] ?? '',
      details: { ...emptyTicketDetails(), ...details },
    };
    this.tickets.set(key, ticket);
    return ticket;
  }

  async listTriggered(): Promise<TicketRef[]> {
    return this.triggered;
  }

  async getTicket(key: string): Promise<Ticket> {
    const t = this.tickets.get(key);
    if (!t) throw new Error(`ticket ${key} not found`);
    return t;
  }

  async comment(key: string, markdown: string, kind?: CommentKind): Promise<{ id: string }> {
    this.comments.push({ key, markdown, kind });
    return { id: `c-${this.comments.length}` };
  }

  async transition(key: string, to: string): Promise<TransitionResult> {
    const from = this.tickets.get(key)?.details.status ?? '';
    if (this.unavailableTransitions.has(to))
      return { ok: false, from, to, reason: `no transition to "${to}"` };
    this.transitions.push({ key, to });
    const t = this.tickets.get(key);
    if (t) t.details.status = to;
    return { ok: true, from, to };
  }

  verifyWebhook(req: WebhookRequest): boolean {
    return (
      req.headers['x-mates-secret'] === this.webhookSecret ||
      req.query.secret === this.webhookSecret
    );
  }

  parseWebhook(req: WebhookRequest): TrackerEvent[] {
    return Array.isArray(req.body) ? (req.body as TrackerEvent[]) : [];
  }

  async test(): Promise<TrackerTestResult> {
    return { ok: true, message: 'fake tracker', matched: this.triggered };
  }
}
