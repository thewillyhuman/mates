import { HttpClient, HttpError } from '../http-client.js';
import { adfToMarkdown, markdownToAdf } from './adf.js';
import {
  TrackerError,
  type CommentKind,
  type Ticket,
  type TicketRef,
  type Tracker,
  type TrackerEvent,
  type TrackerTestResult,
  type TransitionResult,
  type TriggerRule,
  type WebhookRequest,
} from './tracker.js';
import { emptyTicketDetails, type TicketDetails } from './types.js';

/**
 * Jira adapter (§8.1): Cloud (email + API token, REST v3, ADF) and Data
 * Center (personal access token, REST v2, wiki text). Comments carry the
 * configurable prefix and a link to the run; transitions are resolved by
 * target status name.
 */
export interface JiraOptions {
  baseUrl: string;
  auth: 'cloud' | 'datacenter';
  email: string;
  token: string;
  webhookSecret: string;
  webhookSecretIn: 'header' | 'query';
  commentPrefix: string;
  /** Builds the run link appended to comments. */
  runUrl: (runId: string) => string;
  /** Custom field holding acceptance criteria, e.g. `customfield_10042`; empty → parse the description. */
  acceptanceCriteriaField?: string;
  fetch?: typeof fetch;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    labels?: string[];
    reporter?: { displayName?: string; emailAddress?: string };
    assignee?: { displayName?: string; emailAddress?: string } | null;
    updated?: string;
    comment?: { comments?: JiraComment[] };
    issuelinks?: { outwardIssue?: { key: string }; inwardIssue?: { key: string } }[];
    [k: string]: unknown;
  };
}

interface JiraComment {
  id: string;
  author?: { displayName?: string; accountId?: string; name?: string; emailAddress?: string };
  body?: unknown;
  created?: string;
}

export function jqlForRule(rule: TriggerRule): string {
  const quote = (v: string) => `"${v.replace(/"/g, '\\"')}"`;
  switch (rule.kind) {
    case 'assignee':
      return `assignee = ${quote(rule.value)}`;
    case 'label':
      return `labels = ${quote(rule.value)}`;
    case 'status':
      return `status = ${quote(rule.value)}`;
    case 'jql':
      return rule.value;
  }
}

/** The "Acceptance criteria" section of a markdown description, if any. */
export function extractAcceptanceCriteria(description: string): string {
  const m = /^#{1,6}\s*acceptance criteria\s*:?\s*$([\s\S]*?)(?=^#{1,6}\s|\s*$(?![\s\S]))/im.exec(
    description,
  );
  if (m) return m[1]!.trim();
  const bold =
    /\*\*acceptance criteria:?\*\*:?\s*([\s\S]*?)(?=\n\s*\*\*[^*]+\*\*|\n{2,}#|$(?![\s\S]))/i.exec(
      description,
    );
  return bold ? bold[1]!.trim() : '';
}

export class JiraTracker implements Tracker {
  private readonly http: HttpClient;
  private readonly v: 2 | 3;

  constructor(private readonly opts: JiraOptions) {
    this.v = opts.auth === 'cloud' ? 3 : 2;
    const authHeader =
      opts.auth === 'cloud'
        ? `Basic ${Buffer.from(`${opts.email}:${opts.token}`).toString('base64')}`
        : `Bearer ${opts.token}`;
    this.http = new HttpClient({
      baseUrl: opts.baseUrl,
      headers: { authorization: authHeader },
      fetch: opts.fetch,
    });
  }

  private api(path: string): string {
    return `/rest/api/${this.v}${path}`;
  }

  async listTriggered(rule: TriggerRule): Promise<TicketRef[]> {
    const jql = `${jqlForRule(rule)} ORDER BY updated DESC`;
    const fields = ['summary', 'updated'];
    let issues: JiraIssue[];
    try {
      if (this.v === 3) {
        const r = await this.http.json<{ issues: JiraIssue[] }>('POST', this.api('/search/jql'), {
          jql,
          fields,
          maxResults: 50,
        });
        issues = r.issues;
      } else {
        const r = await this.http.json<{ issues: JiraIssue[] }>(
          'GET',
          `${this.api('/search')}?jql=${encodeURIComponent(jql)}&fields=${fields.join(',')}&maxResults=50`,
        );
        issues = r.issues;
      }
    } catch (err) {
      throw wrap(err, 'search');
    }
    return issues.map((i) => ({
      key: i.key,
      id: i.id,
      summary: i.fields.summary ?? '',
      updated: i.fields.updated ?? '',
    }));
  }

  async getTicket(key: string): Promise<Ticket> {
    const fields = [
      'summary',
      'description',
      'status',
      'labels',
      'reporter',
      'assignee',
      'updated',
      'comment',
      'issuelinks',
    ];
    if (this.opts.acceptanceCriteriaField) fields.push(this.opts.acceptanceCriteriaField);
    let issue: JiraIssue;
    try {
      issue = await this.http.json<JiraIssue>(
        'GET',
        `${this.api(`/issue/${encodeURIComponent(key)}`)}?fields=${fields.join(',')}`,
      );
    } catch (err) {
      throw wrap(err, `issue ${key}`);
    }
    const description = this.render(issue.fields.description);
    const acField = this.opts.acceptanceCriteriaField
      ? this.render(issue.fields[this.opts.acceptanceCriteriaField])
      : '';
    const details: TicketDetails = {
      ...emptyTicketDetails(),
      description,
      acceptance_criteria: acField || extractAcceptanceCriteria(description),
      comments: (issue.fields.comment?.comments ?? []).map((c) => ({
        id: c.id,
        author: c.author?.displayName ?? c.author?.name ?? 'unknown',
        body: this.render(c.body),
        created_at: c.created ?? '',
      })),
      links: (issue.fields.issuelinks ?? [])
        .map((l) => l.outwardIssue?.key ?? l.inwardIssue?.key)
        .filter((k): k is string => Boolean(k))
        .map((k) => `${this.http.baseUrl}/browse/${k}`),
      labels: issue.fields.labels ?? [],
      reporter: issue.fields.reporter?.displayName ?? '',
      assignee: issue.fields.assignee?.displayName ?? '',
      status: issue.fields.status?.name ?? '',
    };
    return {
      key: issue.key,
      id: issue.id,
      title: issue.fields.summary ?? issue.key,
      url: `${this.http.baseUrl}/browse/${issue.key}`,
      projectKey: issue.key.split('-')[0] ?? '',
      details,
    };
  }

  private render(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    return adfToMarkdown(value);
  }

  async comment(key: string, markdown: string, _kind?: CommentKind): Promise<{ id: string }> {
    const body = this.v === 3 ? markdownToAdf(markdown) : markdown;
    try {
      const r = await this.http.json<{ id: string }>(
        'POST',
        this.api(`/issue/${encodeURIComponent(key)}/comment`),
        { body },
      );
      return { id: r.id };
    } catch (err) {
      throw wrap(err, `comment on ${key}`);
    }
  }

  /** Formats a Mates comment: prefix, text, run link (§8.1). */
  formatComment(text: string, runId: string): string {
    return `${this.opts.commentPrefix} ${text}\n\n[Open the run in Mates](${this.opts.runUrl(runId)})`;
  }

  async transition(key: string, toStatusName: string): Promise<TransitionResult> {
    let r: { transitions: { id: string; name: string; to: { name: string } }[] };
    let current = '';
    try {
      const issue = await this.http.json<JiraIssue>(
        'GET',
        `${this.api(`/issue/${encodeURIComponent(key)}`)}?fields=status`,
      );
      current = issue.fields.status?.name ?? '';
      r = await this.http.json('GET', this.api(`/issue/${encodeURIComponent(key)}/transitions`));
    } catch (err) {
      throw wrap(err, `transitions of ${key}`);
    }
    if (current.toLowerCase() === toStatusName.toLowerCase())
      return { ok: true, from: current, to: current };
    const t = r.transitions.find((x) => x.to.name.toLowerCase() === toStatusName.toLowerCase());
    if (!t) {
      return {
        ok: false,
        from: current,
        to: toStatusName,
        reason: `no transition from "${current}" to "${toStatusName}" (available: ${r.transitions.map((x) => x.to.name).join(', ') || 'none'})`,
      };
    }
    try {
      await this.http.json('POST', this.api(`/issue/${encodeURIComponent(key)}/transitions`), {
        transition: { id: t.id },
      });
    } catch (err) {
      throw wrap(err, `transition ${key} → ${toStatusName}`);
    }
    return { ok: true, from: current, to: t.to.name };
  }

  verifyWebhook(req: WebhookRequest): boolean {
    if (!this.opts.webhookSecret) return false;
    const given =
      this.opts.webhookSecretIn === 'query'
        ? req.query.secret
        : (headerValue(req.headers['x-mates-secret']) ??
          headerValue(req.headers['x-hub-signature']));
    return given !== undefined && safeEqual(given, this.opts.webhookSecret);
  }

  parseWebhook(req: WebhookRequest, rule: TriggerRule): TrackerEvent[] {
    const body = req.body as {
      webhookEvent?: string;
      issue?: { id?: string; key?: string; fields?: Record<string, unknown> };
      changelog?: {
        items?: { field?: string; fieldId?: string; toString?: string; to?: string }[];
      };
      comment?: JiraComment;
    };
    if (!body?.issue?.key || !body.issue.id) return [];
    const key = body.issue.key;
    const id = body.issue.id;
    if (body.webhookEvent === 'comment_created' && body.comment) {
      const text = this.render(body.comment.body);
      return [
        {
          type: 'comment_created',
          key,
          id,
          commentId: body.comment.id,
          author: body.comment.author?.displayName ?? body.comment.author?.name ?? 'unknown',
          authorIsSelf:
            text.startsWith(this.opts.commentPrefix) ||
            (this.opts.email !== '' && body.comment.author?.emailAddress === this.opts.email),
          body: text,
        },
      ];
    }
    if (body.webhookEvent === 'jira:issue_updated' || body.webhookEvent === 'jira:issue_created') {
      return [
        {
          type: 'issue_updated',
          key,
          id,
          matchesRule: ruleMatches(rule, body.issue.fields ?? {}, body.changelog?.items ?? []),
        },
      ];
    }
    return [];
  }

  async test(rule: TriggerRule): Promise<TrackerTestResult> {
    try {
      await this.http.json('GET', this.api('/myself'));
    } catch (err) {
      return {
        ok: false,
        message: `authentication failed: ${(err as Error).message}`,
        matched: [],
      };
    }
    try {
      const matched = await this.listTriggered(rule);
      return {
        ok: true,
        message: `authenticated; ${matched.length} ticket(s) match the trigger rule`,
        matched,
      };
    } catch (err) {
      return {
        ok: false,
        message: `trigger rule is not valid JQL: ${(err as Error).message}`,
        matched: [],
      };
    }
  }
}

/** Whether the issue, after this update, matches the trigger rule (webhooks carry fields; JQL rules fall back to polling). */
export function ruleMatches(
  rule: TriggerRule,
  fields: Record<string, unknown>,
  items: { field?: string }[],
): boolean {
  const changed = (name: string) => items.some((i) => (i.field ?? '').toLowerCase() === name);
  switch (rule.kind) {
    case 'assignee': {
      const a = fields.assignee as
        | { displayName?: string; emailAddress?: string; name?: string; accountId?: string }
        | null
        | undefined;
      const v = rule.value.toLowerCase();
      return (
        Boolean(
          a &&
          [a.displayName, a.emailAddress, a.name, a.accountId].some((x) => x?.toLowerCase() === v),
        ) &&
        (items.length === 0 || changed('assignee'))
      );
    }
    case 'label': {
      const labels = (fields.labels as string[] | undefined) ?? [];
      return labels.includes(rule.value) && (items.length === 0 || changed('labels'));
    }
    case 'status': {
      const s = (fields.status as { name?: string } | undefined)?.name ?? '';
      return (
        s.toLowerCase() === rule.value.toLowerCase() && (items.length === 0 || changed('status'))
      );
    }
    case 'jql':
      return false; // cannot evaluate JQL locally; the poller picks it up
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function wrap(err: unknown, what: string): TrackerError {
  if (err instanceof HttpError) return new TrackerError(`jira ${what}: ${err.message}`, err.status);
  return new TrackerError(`jira ${what}: ${(err as Error).message}`);
}
