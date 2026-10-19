import { describe, expect, it } from 'vitest';
import { fixtureFetch, loadFixture } from '../../test/http-fixtures.js';
import { adfToMarkdown, markdownToAdf } from './adf.js';
import { JiraTracker, extractAcceptanceCriteria, jqlForRule, ruleMatches } from './jira.js';
import { TrackerError } from './tracker.js';

function cloud() {
  const f = fixtureFetch(loadFixture('jira', 'cloud'));
  const jira = new JiraTracker({
    baseUrl: 'https://example.atlassian.net/',
    auth: 'cloud',
    email: 'mates@example.com',
    token: 'api-token',
    webhookSecret: 'whsec',
    webhookSecretIn: 'header',
    commentPrefix: '🤖 Mates:',
    runUrl: (id) => `https://mates.example.com/runs/${id}`,
    fetch: f.fetch,
  });
  return { jira, calls: f.calls };
}

describe('jqlForRule', () => {
  it('builds JQL for each trigger kind and quotes values', () => {
    expect(jqlForRule({ kind: 'assignee', value: 'mates@example.com' })).toBe(
      'assignee = "mates@example.com"',
    );
    expect(jqlForRule({ kind: 'label', value: 'ai"x' })).toBe('labels = "ai\\"x"');
    expect(jqlForRule({ kind: 'status', value: 'Ready for Mates' })).toBe(
      'status = "Ready for Mates"',
    );
    expect(jqlForRule({ kind: 'jql', value: 'project = API AND labels = mates' })).toBe(
      'project = API AND labels = mates',
    );
  });
});

describe('ADF conversion', () => {
  it('renders the common nodes to markdown', () => {
    const md = adfToMarkdown({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a ' },
            { type: 'text', text: 'b', marks: [{ type: 'em' }] },
            { type: 'hardBreak' },
            { type: 'mention', attrs: { text: '@Ana' } },
          ],
        },
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nested' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'x()' }] },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'q' }] }],
        },
      ],
    });
    expect(md).toBe('## Title\n\na _b_\n@Ana\n\n1. one\n  - nested\n\n```ts\nx()\n```\n\n> q');
    expect(adfToMarkdown('plain')).toBe('plain');
  });

  it('turns markdown comments into ADF paragraphs with links and code', () => {
    const adf = markdownToAdf('🤖 Mates: done `x`\n\n[Open](https://m/runs/1)');
    expect(adf).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '🤖 Mates: done ' },
            { type: 'text', text: 'x', marks: [{ type: 'code' }] },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Open',
              marks: [{ type: 'link', attrs: { href: 'https://m/runs/1' } }],
            },
          ],
        },
      ],
    });
  });
});

describe('extractAcceptanceCriteria', () => {
  it('finds a heading or bold section and stops at the next heading', () => {
    expect(
      extractAcceptanceCriteria('intro\n\n## Acceptance criteria\n- a\n- b\n\n## Notes\nx'),
    ).toBe('- a\n- b');
    expect(
      extractAcceptanceCriteria('**Acceptance Criteria:**\n- a\n\n**Out of scope**\n- z'),
    ).toBe('- a');
    expect(extractAcceptanceCriteria('nothing here')).toBe('');
  });
});

describe('JiraTracker (Cloud)', () => {
  it('lists triggered tickets through the v3 search endpoint with basic auth', async () => {
    const { jira, calls } = cloud();
    const refs = await jira.listTriggered({ kind: 'assignee', value: 'mates@example.com' });
    expect(refs.map((r) => r.key)).toEqual(['API-198', 'API-204']);
    expect(calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('mates@example.com:api-token').toString('base64')}`,
    );
    expect(calls[0]!.body).toMatchObject({
      jql: 'assignee = "mates@example.com" ORDER BY updated DESC',
      maxResults: 50,
    });
  });

  it('maps an issue to a ticket with markdown description, criteria, comments and links', async () => {
    const { jira } = cloud();
    const t = await jira.getTicket('API-198');
    expect(t).toMatchObject({
      key: 'API-198',
      id: '10198',
      title: 'Retry policy for webhook delivery',
      url: 'https://example.atlassian.net/browse/API-198',
      projectKey: 'API',
    });
    expect(t.details.description).toContain('Deliveries must retry with **exponential backoff**.');
    expect(t.details.description).toContain('[the design doc](https://wiki.example.com/retry)');
    expect(t.details.acceptance_criteria).toBe(
      '- At most 5 attempts within 10 minutes\n- Exhausted deliveries land in `webhook_dlq`',
    );
    expect(t.details.comments).toEqual([
      {
        id: '20001',
        author: 'Ana Keller',
        body: 'Please keep the existing BackoffSchedule helper.',
        created_at: '2026-10-19T13:00:00.000+0000',
      },
    ]);
    expect(t.details.links).toEqual(['https://example.atlassian.net/browse/API-150']);
    expect(t.details).toMatchObject({
      labels: ['mates', 'backend'],
      reporter: 'Ana Keller',
      assignee: 'Mates',
      status: 'To Do',
    });
  });

  it('wraps API errors with the status', async () => {
    const { jira } = cloud();
    await expect(jira.getTicket('API-404')).rejects.toMatchObject({ status: 404 });
    await expect(jira.getTicket('API-404')).rejects.toBeInstanceOf(TrackerError);
  });

  it('posts ADF comments with the prefix and run link', async () => {
    const { jira, calls } = cloud();
    const r = await jira.comment(
      'API-198',
      jira.formatComment('Clarification needed: which tier?', 'run-1'),
      'clarification',
    );
    expect(r.id).toBe('20002');
    const body = calls[0]!.body as {
      body: { content: { content: { text?: string; marks?: unknown[] }[] }[] };
    };
    expect(body.body.content[0]!.content[0]!.text).toBe(
      '🤖 Mates: Clarification needed: which tier?',
    );
    expect(body.body.content[1]!.content[0]).toMatchObject({
      text: 'Open the run in Mates',
      marks: [{ type: 'link', attrs: { href: 'https://mates.example.com/runs/run-1' } }],
    });
  });

  it('transitions by target status name and reports when no path exists', async () => {
    const { jira, calls } = cloud();
    expect(await jira.transition('API-198', 'In Progress')).toEqual({
      ok: true,
      from: 'To Do',
      to: 'In Progress',
    });
    expect(calls.at(-1)!.body).toEqual({ transition: { id: '21' } });
    const refused = await jira.transition('API-198', 'Needs Info');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('no transition from "To Do" to "Needs Info"');
    expect(await jira.transition('API-198', 'to do')).toEqual({
      ok: true,
      from: 'To Do',
      to: 'To Do',
    });
  });

  it('verifies the webhook secret in a header or the query', () => {
    const { jira } = cloud();
    expect(
      jira.verifyWebhook({ headers: { 'x-mates-secret': 'whsec' }, query: {}, body: {} }),
    ).toBe(true);
    expect(jira.verifyWebhook({ headers: { 'x-mates-secret': 'nope' }, query: {}, body: {} })).toBe(
      false,
    );
    expect(jira.verifyWebhook({ headers: {}, query: { secret: 'whsec' }, body: {} })).toBe(false);
  });

  it('parses issue updates and comments, recognising its own comments', () => {
    const { jira } = cloud();
    const rule = { kind: 'assignee' as const, value: 'mates@example.com' };
    const updated = jira.parseWebhook(
      {
        headers: {},
        query: {},
        body: {
          webhookEvent: 'jira:issue_updated',
          issue: {
            id: '10198',
            key: 'API-198',
            fields: { assignee: { emailAddress: 'mates@example.com' } },
          },
          changelog: { items: [{ field: 'assignee', toString: 'Mates' }] },
        },
      },
      rule,
    );
    expect(updated).toEqual([
      { type: 'issue_updated', key: 'API-198', id: '10198', matchesRule: true },
    ]);
    const other = jira.parseWebhook(
      {
        headers: {},
        query: {},
        body: {
          webhookEvent: 'jira:issue_updated',
          issue: {
            id: '1',
            key: 'API-1',
            fields: { assignee: { emailAddress: 'mates@example.com' } },
          },
          changelog: { items: [{ field: 'summary' }] },
        },
      },
      rule,
    );
    expect(other[0]).toMatchObject({ matchesRule: false });
    const comment = jira.parseWebhook(
      {
        headers: {},
        query: {},
        body: {
          webhookEvent: 'comment_created',
          issue: { id: '10198', key: 'API-198' },
          comment: {
            id: '9',
            author: { displayName: 'Ana' },
            body: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Free tier is 100 req/min.' }],
                },
              ],
            },
          },
        },
      },
      rule,
    );
    expect(comment).toEqual([
      {
        type: 'comment_created',
        key: 'API-198',
        id: '10198',
        commentId: '9',
        author: 'Ana',
        authorIsSelf: false,
        body: 'Free tier is 100 req/min.',
      },
    ]);
    const own = jira.parseWebhook(
      {
        headers: {},
        query: {},
        body: {
          webhookEvent: 'comment_created',
          issue: { id: '10198', key: 'API-198' },
          comment: {
            id: '10',
            author: { displayName: 'Mates' },
            body: '🤖 Mates: Clarification needed',
          },
        },
      },
      rule,
    );
    expect(own[0]).toMatchObject({ authorIsSelf: true });
    expect(jira.parseWebhook({ headers: {}, query: {}, body: { nope: true } }, rule)).toEqual([]);
  });

  it('tests authentication and the rule', async () => {
    const { jira } = cloud();
    expect(await jira.test({ kind: 'assignee', value: 'mates@example.com' })).toMatchObject({
      ok: true,
      matched: [{ key: 'API-198' }, { key: 'API-204' }],
    });
    const bad = await jira.test({ kind: 'jql', value: 'this is not jql' });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('not valid JQL');
  });
});

describe('JiraTracker (Data Center)', () => {
  it('uses v2, bearer auth, GET search, a custom acceptance-criteria field and plain-text comments', async () => {
    const f = fixtureFetch(loadFixture('jira', 'datacenter'));
    const jira = new JiraTracker({
      baseUrl: 'https://jira.corp.example.com',
      auth: 'datacenter',
      email: '',
      token: 'pat',
      webhookSecret: 's',
      webhookSecretIn: 'query',
      commentPrefix: '🤖 Mates:',
      runUrl: (id) => `https://m/runs/${id}`,
      acceptanceCriteriaField: 'customfield_10042',
      fetch: f.fetch,
    });
    const refs = await jira.listTriggered({ kind: 'label', value: 'mates' });
    expect(refs.map((r) => r.key)).toEqual(['WEB-88']);
    expect(f.calls[0]!.headers.authorization).toBe('Bearer pat');
    const t = await jira.getTicket('WEB-88');
    expect(t.details.acceptance_criteria).toBe(
      '- All fields validate on blur\n- Errors are announced',
    );
    expect(t.details.description).toContain('h2. Context');
    await jira.comment('WEB-88', '🤖 Mates: hi');
    expect(f.calls.at(-1)!.body).toEqual({ body: '🤖 Mates: hi' });
    expect(jira.verifyWebhook({ headers: {}, query: { secret: 's' }, body: {} })).toBe(true);
  });
});

describe('ruleMatches', () => {
  it('matches assignee, label and status changes only when the field changed', () => {
    expect(
      ruleMatches({ kind: 'label', value: 'mates' }, { labels: ['mates'] }, [{ field: 'labels' }]),
    ).toBe(true);
    expect(
      ruleMatches({ kind: 'label', value: 'mates' }, { labels: ['mates'] }, [{ field: 'status' }]),
    ).toBe(false);
    expect(ruleMatches({ kind: 'status', value: 'ready' }, { status: { name: 'Ready' } }, [])).toBe(
      true,
    );
    expect(ruleMatches({ kind: 'jql', value: 'x' }, {}, [])).toBe(false);
  });
});
