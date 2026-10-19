import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, del, get, post, put, qs } from '../../api/client.js';
import { useAuth } from '../../api/auth.js';
import type {
  ApiTokenView,
  AuditEntry,
  PromptView,
  Settings,
  TeamContextVersion,
} from '../../api/types.js';
import type { User } from '../../api/client.js';
import { Chip, ErrorBox } from '../../components/ui.js';
import { formatDateTime } from '../../lib/format.js';
import { CredentialField, Field, SaveBar, useSave, useSettings } from './common.js';

/** The wizard steps of §6.2 as tabs, plus users, tokens, prompts and pricing (§13.6). */

export function AnthropicTab() {
  const { settings } = useSettings();
  const [draft, setDraft] = useState(settings.anthropic);
  const { busy, result, run } = useSave('anthropic');
  const envs: Record<string, string> = {
    bedrock:
      'CLAUDE_CODE_USE_BEDROCK=1, AWS_REGION, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (or an IRSA role on the runner ServiceAccount)',
    vertex:
      'CLAUDE_CODE_USE_VERTEX=1, CLOUD_ML_REGION, ANTHROPIC_VERTEX_PROJECT_ID, GOOGLE_APPLICATION_CREDENTIALS',
    foundry: 'CLAUDE_CODE_USE_FOUNDRY=1 and the Azure endpoint/credential variables',
  };
  return (
    <section className="card">
      <h2>Anthropic</h2>
      <Field
        label="Provider"
        path="anthropic.provider"
        type="select"
        value={draft.provider}
        onChange={(v) => setDraft({ provider: v as Settings['anthropic']['provider'] })}
        options={[
          { value: 'api_key', label: 'Anthropic API key' },
          { value: 'bedrock', label: 'Amazon Bedrock' },
          { value: 'vertex', label: 'Google Vertex AI' },
          { value: 'foundry', label: 'Microsoft Foundry' },
        ]}
      />
      <SaveBar onSave={() => void run(draft)} busy={busy} result={result} />
      {draft.provider === 'api_key' ? (
        <CredentialField
          name="anthropic_api_key"
          label="API key"
          hint="Test runs a minimal claude -p in a short-lived pod and reports model, latency and cost."
        />
      ) : (
        <p className="hint">
          Set these on the runner through the chart's <code>runner.extraEnv</code>:{' '}
          {envs[draft.provider]}
        </p>
      )}
    </section>
  );
}

export function JiraTab() {
  const { settings } = useSettings();
  const [d, setD] = useState(settings.jira);
  const { busy, result, run } = useSave('jira');
  const set = (patch: Partial<Settings['jira']>) => setD({ ...d, ...patch });
  const origin = window.location.origin;
  const webhookUrl =
    d.webhook_secret_in === 'query'
      ? `${origin}/webhooks/jira?secret=<secret>`
      : `${origin}/webhooks/jira`;
  return (
    <section className="card">
      <h2>Jira</h2>
      <div className="form-grid">
        <Field
          label="Base URL"
          path="jira.base_url"
          type="url"
          value={d.base_url}
          onChange={(v) => set({ base_url: v })}
          placeholder="https://example.atlassian.net"
        />
        <Field
          label="Deployment"
          path="jira.auth"
          type="select"
          value={d.auth}
          onChange={(v) => set({ auth: v as 'cloud' | 'datacenter' })}
          options={[
            { value: 'cloud', label: 'Cloud (email + API token)' },
            { value: 'datacenter', label: 'Data Center (personal access token)' },
          ]}
        />
        {d.auth === 'cloud' && (
          <Field
            label="Email"
            path="jira.email"
            value={d.email}
            onChange={(v) => set({ email: v })}
          />
        )}
        <Field
          label="Trigger rule"
          path="jira.trigger.kind"
          type="select"
          value={d.trigger.kind}
          onChange={(v) =>
            set({ trigger: { ...d.trigger, kind: v as Settings['jira']['trigger']['kind'] } })
          }
          options={[
            { value: 'assignee', label: 'Assignee is…' },
            { value: 'label', label: 'Label is…' },
            { value: 'status', label: 'Status is…' },
            { value: 'jql', label: 'Custom JQL' },
          ]}
        />
        <Field
          label={d.trigger.kind === 'jql' ? 'JQL' : 'Value'}
          path="jira.trigger.value"
          value={d.trigger.value}
          onChange={(v) => set({ trigger: { ...d.trigger, value: v } })}
          placeholder={
            d.trigger.kind === 'assignee'
              ? 'mates@example.com'
              : d.trigger.kind === 'jql'
                ? 'project = API AND labels = mates'
                : ''
          }
        />
        <Field
          label="Poll interval (s)"
          path="jira.poll_interval_seconds"
          type="number"
          value={d.poll_interval_seconds}
          onChange={(v) => set({ poll_interval_seconds: Number(v) })}
        />
      </div>
      <h3>Status mapping (each optional)</h3>
      <div className="form-grid">
        <Field
          label="Intake"
          path="jira.status_map.intake"
          value={d.status_map.intake}
          onChange={(v) => set({ status_map: { ...d.status_map, intake: v } })}
        />
        <Field
          label="Implementing / reviewing"
          path="jira.status_map.in_progress"
          value={d.status_map.in_progress}
          onChange={(v) => set({ status_map: { ...d.status_map, in_progress: v } })}
          placeholder="In Progress"
        />
        <Field
          label="MR ready"
          path="jira.status_map.mr_ready"
          value={d.status_map.mr_ready}
          onChange={(v) => set({ status_map: { ...d.status_map, mr_ready: v } })}
          placeholder="In Review"
        />
        <Field
          label="Blocked"
          path="jira.status_map.blocked"
          value={d.status_map.blocked}
          onChange={(v) => set({ status_map: { ...d.status_map, blocked: v } })}
          placeholder="Needs Info"
        />
      </div>
      <h3>Comments</h3>
      <Field
        label="Post clarification questions"
        path="jira.comments.clarification"
        type="checkbox"
        value={d.comments.clarification}
        onChange={(v) => set({ comments: { ...d.comments, clarification: v === 'true' } })}
      />
      <Field
        label="Post stage updates (ready, blocked, failed)"
        path="jira.comments.status"
        type="checkbox"
        value={d.comments.status}
        onChange={(v) => set({ comments: { ...d.comments, status: v === 'true' } })}
      />
      <Field
        label="Include cost, iterations and models in the final comment"
        path="jira.comments.cost"
        type="checkbox"
        value={d.comments.cost}
        onChange={(v) => set({ comments: { ...d.comments, cost: v === 'true' } })}
      />
      <Field
        label="Comment prefix"
        path="jira.comment_prefix"
        value={d.comment_prefix}
        onChange={(v) => set({ comment_prefix: v })}
      />
      <Field
        label="Webhook secret location"
        path="jira.webhook_secret_in"
        type="select"
        value={d.webhook_secret_in}
        onChange={(v) => set({ webhook_secret_in: v as 'header' | 'query' })}
        options={[
          { value: 'header', label: 'X-Mates-Secret header' },
          { value: 'query', label: '?secret= query parameter' },
        ]}
      />
      <SaveBar onSave={() => void run(d)} busy={busy} result={result} />
      <CredentialField
        name="jira_token"
        label={d.auth === 'cloud' ? 'API token' : 'Personal access token'}
        hint="Test validates the credentials and the trigger rule and lists the tickets it matches."
      />
      <CredentialField
        name="jira_webhook_secret"
        label="Webhook secret"
        test={false}
        hint={
          <>
            Configure a Jira webhook (issue updated, comment created) or an Automation rule to call{' '}
            <code>{webhookUrl}</code>
            {d.webhook_secret_in === 'header'
              ? ' with the secret in the X-Mates-Secret header'
              : ''}
            .
          </>
        }
      />
      <details>
        <summary>Automation rule body example</summary>
        <pre className="small">
          {JSON.stringify(
            {
              webhookEvent: 'jira:issue_updated',
              issue: {
                id: '{{issue.id}}',
                key: '{{issue.key}}',
                fields: {
                  assignee: { emailAddress: '{{issue.assignee.emailAddress}}' },
                  labels: ['{{issue.labels}}'],
                  status: { name: '{{issue.status.name}}' },
                },
              },
              changelog: { items: [{ field: 'assignee' }] },
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}

export function ScmTab() {
  const { settings } = useSettings();
  const [providers, setProviders] = useState(settings.scm.providers);
  const { busy, result, run } = useSave('scm');
  const update = (i: number, patch: Partial<Settings['scm']['providers'][number]>) =>
    setProviders(providers.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <section className="card">
      <h2>Source control</h2>
      {providers.map((p, i) => (
        <div className="card" key={i} style={{ marginBottom: 12 }}>
          <div className="form-grid">
            <Field
              label="Provider id (used in mates.yaml)"
              path={`scm.providers.${i}.id`}
              value={p.id}
              onChange={(v) => update(i, { id: v })}
              placeholder="gitlab"
            />
            <Field
              label="Type"
              path={`scm.providers.${i}.type`}
              type="select"
              value={p.type}
              onChange={(v) => update(i, { type: v as 'gitlab' | 'github' | 'gitea' })}
              options={[
                { value: 'gitlab', label: 'GitLab' },
                { value: 'github', label: 'GitHub' },
                { value: 'gitea', label: 'Gitea / Forgejo' },
              ]}
            />
            <Field
              label="Base URL"
              path={`scm.providers.${i}.base_url`}
              type="url"
              value={p.base_url}
              onChange={(v) => update(i, { base_url: v })}
              placeholder={
                p.type === 'github' ? 'https://github.com' : 'https://gitlab.example.com'
              }
            />
            {p.type === 'gitea' && (
              <Field
                label="Token owner (clone username)"
                path={`scm.providers.${i}.username`}
                value={p.username}
                onChange={(v) => update(i, { username: v })}
              />
            )}
            <Field
              label="MR labels (comma separated)"
              path={`scm.providers.${i}.labels`}
              value={p.labels.join(', ')}
              onChange={(v) =>
                update(i, {
                  labels: v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
            <Field
              label="Reviewers to request (usernames)"
              path={`scm.providers.${i}.reviewers`}
              value={p.reviewers.join(', ')}
              onChange={(v) =>
                update(i, {
                  reviewers: v
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </div>
          <Field
            label="Open merge requests as drafts"
            path={`scm.providers.${i}.draft_mrs`}
            type="checkbox"
            value={p.draft_mrs}
            onChange={(v) => update(i, { draft_mrs: v === 'true' })}
          />
          {p.id && (
            <CredentialField
              name={`scm_${p.id}_token`}
              label={`${p.type === 'github' ? 'Personal access token' : 'Token'} for ${p.id}`}
              hint={
                p.type === 'gitlab'
                  ? 'Scopes api + write_repository.'
                  : p.type === 'github'
                    ? 'A PAT with repo scope; GitHub App support arrives with M7.'
                    : 'An access token with repository and issue write scopes.'
              }
            />
          )}
          <button
            className="btn btn-sm btn-danger"
            type="button"
            onClick={() => setProviders(providers.filter((_, j) => j !== i))}
          >
            Remove provider
          </button>
        </div>
      ))}
      <div className="row">
        <button
          className="btn"
          type="button"
          onClick={() =>
            setProviders([
              ...providers,
              {
                id: '',
                type: 'gitlab',
                base_url: '',
                username: '',
                draft_mrs: true,
                labels: [],
                reviewers: [],
              },
            ])
          }
        >
          Add provider
        </button>
        <SaveBar onSave={() => void run({ providers })} busy={busy} result={result} />
      </div>
    </section>
  );
}

export function TeamContextTab() {
  const { settings } = useSettings();
  const [d, setD] = useState(settings.team_context);
  const { busy, result, run } = useSave('team_context');
  const [versions, setVersions] = useState<TeamContextVersion[]>([]);
  const [upload, setUpload] = useState<{ ok: boolean; message: string } | null>(null);
  const load = () =>
    get<{ versions: TeamContextVersion[] }>('/api/settings/team-context')
      .then((r) => setVersions(r.versions))
      .catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);
  async function onFile(file: File) {
    try {
      const v = await api<TeamContextVersion>('POST', '/api/settings/team-context', undefined, {
        raw: await file.arrayBuffer(),
        contentType: 'application/gzip',
      });
      setUpload(
        v.active
          ? { ok: true, message: `Version ${v.version} is active.` }
          : { ok: false, message: `Version ${v.version} rejected: ${v.errors.join('; ')}` },
      );
      await load();
    } catch (err) {
      setUpload({ ok: false, message: err instanceof ApiError ? err.message : String(err) });
    }
  }
  return (
    <section className="card">
      <h2>Team context</h2>
      <p className="hint">
        A directory with <code>mates.yaml</code> at its root (§6.3) and the markdown the mates read.
        Upload it as a <code>.tar.gz</code>; fetching from a git URL on a configured provider
        arrives with M7.
      </p>
      <div className="form-grid">
        <Field
          label="Source"
          path="team_context.source"
          type="select"
          value={d.source}
          onChange={(v) => setD({ ...d, source: v as 'upload' | 'git' })}
          options={[
            { value: 'upload', label: 'Uploaded package' },
            { value: 'git', label: 'Git repository (M7)' },
          ]}
        />
        {d.source === 'git' && (
          <>
            <Field
              label="Git URL"
              path="team_context.git_url"
              type="url"
              value={d.git_url}
              onChange={(v) => setD({ ...d, git_url: v })}
            />
            <Field
              label="Ref"
              path="team_context.git_ref"
              value={d.git_ref}
              onChange={(v) => setD({ ...d, git_ref: v })}
            />
          </>
        )}
      </div>
      <SaveBar onSave={() => void run(d)} busy={busy} result={result} />
      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="tc-upload">Upload package (.tar.gz)</label>
        <input
          id="tc-upload"
          type="file"
          accept=".tgz,.tar.gz,application/gzip"
          onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
        />
        {upload && (
          <span className={upload.ok ? 'result-ok' : 'result-fail'}>{upload.message}</span>
        )}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Version</th>
            <th>State</th>
            <th>Uploaded</th>
            <th>By</th>
            <th>Validation</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id}>
              <td>v{v.version}</td>
              <td>
                {v.active ? (
                  <Chip tone="green">active</Chip>
                ) : v.errors.length ? (
                  <Chip tone="red">invalid</Chip>
                ) : (
                  <Chip tone="gray">superseded</Chip>
                )}
              </td>
              <td className="muted">{formatDateTime(v.fetchedAt)}</td>
              <td className="muted">{v.createdBy}</td>
              <td>
                {v.errors.length
                  ? v.errors.map((e) => (
                      <div key={e} className="small tone-red">
                        {e}
                      </div>
                    ))
                  : 'ok'}
              </td>
            </tr>
          ))}
          {versions.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No package uploaded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

export function ModelsTab() {
  const { settings } = useSettings();
  const [mates, setMates] = useState(settings.mates);
  const [limits, setLimits] = useState(settings.limits);
  const m = useSave('mates');
  const l = useSave('limits');
  const known = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  return (
    <section className="card">
      <h2>Models & budgets</h2>
      <datalist id="known-models">
        {known.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {(['intake', 'implementer', 'reviewer'] as const).map((mate) => (
        <div key={mate} className="card" style={{ marginBottom: 12 }}>
          <div className="section-title">{mate.toUpperCase()}</div>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={`model-${mate}`}>
                Model id
                {settings && (
                  <span className="hint"> (any id; a list of known ones is suggested)</span>
                )}
              </label>
              <input
                id={`model-${mate}`}
                className="input"
                list="known-models"
                value={mates[mate].model}
                onChange={(e) =>
                  setMates({ ...mates, [mate]: { ...mates[mate], model: e.target.value } })
                }
              />
            </div>
            <Field
              label="Effort"
              path={`mates.${mate}.effort`}
              type="select"
              value={mates[mate].effort ?? ''}
              onChange={(v) =>
                setMates({
                  ...mates,
                  [mate]: {
                    ...mates[mate],
                    effort: (v || null) as 'low' | 'medium' | 'high' | null,
                  },
                })
              }
              options={[
                { value: '', label: 'default' },
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
              ]}
            />
            <Field
              label="Max budget per invocation (USD)"
              path={`mates.${mate}.max_budget_usd`}
              type="number"
              value={mates[mate].max_budget_usd}
              onChange={(v) =>
                setMates({ ...mates, [mate]: { ...mates[mate], max_budget_usd: Number(v) } })
              }
            />
            <Field
              label="Max turns"
              path={`mates.${mate}.max_turns`}
              type="number"
              value={mates[mate].max_turns}
              onChange={(v) =>
                setMates({ ...mates, [mate]: { ...mates[mate], max_turns: Number(v) } })
              }
            />
            <Field
              label="Timeout (s)"
              path={`mates.${mate}.timeout_seconds`}
              type="number"
              value={mates[mate].timeout_seconds}
              onChange={(v) =>
                setMates({ ...mates, [mate]: { ...mates[mate], timeout_seconds: Number(v) } })
              }
            />
          </div>
        </div>
      ))}
      <SaveBar onSave={() => void m.run(mates)} busy={m.busy} result={m.result} />
      <h3>Global limits</h3>
      <div className="form-grid">
        <Field
          label="Max iterations"
          path="limits.max_iterations"
          type="number"
          value={limits.max_iterations}
          onChange={(v) => setLimits({ ...limits, max_iterations: Number(v) })}
        />
        <Field
          label="Budget per run (USD)"
          path="limits.per_run_usd"
          type="number"
          value={limits.per_run_usd}
          onChange={(v) => setLimits({ ...limits, per_run_usd: Number(v) })}
        />
        <Field
          label="Budget per day (USD)"
          path="limits.per_day_usd"
          type="number"
          value={limits.per_day_usd}
          onChange={(v) => setLimits({ ...limits, per_day_usd: Number(v) })}
        />
        <Field
          label="Timezone (daily reset)"
          path="limits.timezone"
          value={limits.timezone}
          onChange={(v) => setLimits({ ...limits, timezone: v })}
        />
      </div>
      <SaveBar onSave={() => void l.run(limits)} busy={l.busy} result={l.result} />
    </section>
  );
}

export function RunnerTab() {
  const { settings } = useSettings();
  const [d, setD] = useState(settings.runner);
  const { busy, result, run } = useSave('runner');
  const res = (k: 'requests' | 'limits', f: 'cpu' | 'memory', v: string) =>
    setD({ ...d, resources: { ...d.resources, [k]: { ...d.resources[k], [f]: v } } });
  return (
    <section className="card">
      <h2>Runner</h2>
      <div className="form-grid">
        <Field
          label="Default runner image"
          path="runner.image"
          value={d.image}
          onChange={(v) => setD({ ...d, image: v })}
          placeholder="empty = the chart's runner image"
        />
        <Field
          label="Invocation timeout (s)"
          path="runner.timeout_seconds"
          type="number"
          value={d.timeout_seconds}
          onChange={(v) => setD({ ...d, timeout_seconds: Number(v) })}
        />
        <Field
          label="CPU request"
          path="runner.resources.requests.cpu"
          value={d.resources.requests.cpu}
          onChange={(v) => res('requests', 'cpu', v)}
        />
        <Field
          label="Memory request"
          path="runner.resources.requests.memory"
          value={d.resources.requests.memory}
          onChange={(v) => res('requests', 'memory', v)}
        />
        <Field
          label="CPU limit"
          path="runner.resources.limits.cpu"
          value={d.resources.limits.cpu}
          onChange={(v) => res('limits', 'cpu', v)}
        />
        <Field
          label="Memory limit"
          path="runner.resources.limits.memory"
          value={d.resources.limits.memory}
          onChange={(v) => res('limits', 'memory', v)}
        />
        <Field
          label="Workspace size (Gi)"
          path="runner.workspace_size_gi"
          type="number"
          value={d.workspace_size_gi}
          onChange={(v) => setD({ ...d, workspace_size_gi: Number(v) })}
        />
        <Field
          label="Extra CA bundle ConfigMap"
          path="runner.ca_bundle_configmap"
          value={d.ca_bundle_configmap}
          onChange={(v) => setD({ ...d, ca_bundle_configmap: v })}
          hint="ConfigMap with a ca.crt key, mounted into runner pods."
        />
        <Field
          label="HTTP proxy"
          path="runner.http_proxy"
          value={d.http_proxy}
          onChange={(v) => setD({ ...d, http_proxy: v })}
        />
        <Field
          label="No proxy"
          path="runner.no_proxy"
          value={d.no_proxy}
          onChange={(v) => setD({ ...d, no_proxy: v })}
        />
        <Field
          label="Image pull secret"
          path="runner.image_pull_secret"
          value={d.image_pull_secret}
          onChange={(v) => setD({ ...d, image_pull_secret: v })}
        />
      </div>
      <SaveBar onSave={() => void run(d)} busy={busy} result={result} />
    </section>
  );
}

export function NotificationsTab() {
  const { settings } = useSettings();
  const [d, setD] = useState(settings.notifications);
  const { busy, result, run } = useSave('notifications');
  return (
    <section className="card">
      <h2>Notifications</h2>
      <Field
        label="Webhook URL (Slack-compatible JSON)"
        path="notifications.webhook_url"
        type="url"
        value={d.webhook_url}
        onChange={(v) => setD({ webhook_url: v })}
        hint="Fired on clarification requests, blocked runs, ready merge requests, failures and budget stops (delivery arrives with M7)."
      />
      <SaveBar onSave={() => void run(d)} busy={busy} result={result} />
    </section>
  );
}

export function UsersTab() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState({
    email: '',
    displayName: '',
    role: 'viewer' as User['role'],
    password: '',
  });
  const load = () =>
    get<{ users: User[] }>('/api/users')
      .then((r) => setUsers(r.users))
      .catch(setError);
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="card">
      <h2>Users</h2>
      <ErrorBox error={error} />
      <table className="data">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Auth</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>{u.displayName}</td>
              <td>
                <select
                  className="input"
                  value={u.role}
                  disabled={u.id === me?.id}
                  onChange={(e) =>
                    void put(`/api/users/${u.id}`, { role: e.target.value })
                      .then(load)
                      .catch(setError)
                  }
                  aria-label={`Role of ${u.email}`}
                >
                  <option value="viewer">viewer</option>
                  <option value="operator">operator</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td>{u.auth}</td>
              <td>
                {u.id !== me?.id && (
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => void del(`/api/users/${u.id}`).then(load).catch(setError)}
                  >
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Add a user</h3>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          void post('/api/users', draft)
            .then(() => {
              setDraft({ email: '', displayName: '', role: 'viewer', password: '' });
              return load();
            })
            .catch(setError);
        }}
      >
        <div className="field">
          <label htmlFor="u-email">Email</label>
          <input
            id="u-email"
            className="input"
            type="email"
            required
            value={draft.email}
            onChange={(e) => setDraft({ ...draft, email: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="u-name">Display name</label>
          <input
            id="u-name"
            className="input"
            required
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="u-role">Role</label>
          <select
            id="u-role"
            className="input"
            value={draft.role}
            onChange={(e) => setDraft({ ...draft, role: e.target.value as User['role'] })}
          >
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="u-pass">Password (10+ characters)</label>
          <input
            id="u-pass"
            className="input"
            type="password"
            minLength={10}
            required
            value={draft.password}
            onChange={(e) => setDraft({ ...draft, password: e.target.value })}
          />
        </div>
        <div>
          <button className="btn btn-primary" type="submit">
            Create user
          </button>
        </div>
      </form>
    </section>
  );
}

export function TokensTab() {
  const [tokens, setTokens] = useState<ApiTokenView[]>([]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () =>
    get<{ tokens: ApiTokenView[] }>('/api/api-tokens')
      .then((r) => setTokens(r.tokens))
      .catch(setError);
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="card">
      <h2>API tokens</h2>
      <p className="hint">
        For scripts: send <code>Authorization: Bearer &lt;token&gt;</code>. Tokens carry your role
        and need no CSRF header.
      </p>
      <ErrorBox error={error} />
      {created && (
        <div className="banner banner-blue">
          Copy it now, it is shown once: <code>{created}</code>
        </div>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void post<{ token: string }>('/api/api-tokens', { name })
            .then((r) => {
              setCreated(r.token);
              setName('');
              return load();
            })
            .catch(setError);
        }}
      >
        <input
          className="input"
          style={{ width: 240 }}
          placeholder="Token name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Token name"
        />
        <button className="btn btn-primary" type="submit">
          Create token
        </button>
      </form>
      <table className="data" style={{ marginTop: 12 }}>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td className="muted">{t.userEmail}</td>
              <td className="muted">created {formatDateTime(t.createdAt)}</td>
              <td className="muted">
                {t.lastUsedAt ? `used ${formatDateTime(t.lastUsedAt)}` : 'never used'}
              </td>
              <td>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => void del(`/api/api-tokens/${t.id}`).then(load).catch(setError)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function PromptsTab() {
  const [mate, setMate] = useState<'system' | 'intake' | 'implementer' | 'reviewer'>('implementer');
  const [view, setView] = useState<PromptView | null>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    void get<PromptView>(`/api/settings/prompts/${mate}`).then((v) => {
      setView(v);
      setText(v.template);
      setResult(null);
    });
  }, [mate]);
  const save = (template: string | null) =>
    put<PromptView>(`/api/settings/prompts/${mate}`, { template })
      .then((v) => {
        setView(v);
        setText(v.template);
        setResult({ ok: true, message: template === null ? 'Reset to default.' : 'Saved.' });
      })
      .catch((err: unknown) =>
        setResult({ ok: false, message: err instanceof ApiError ? err.message : String(err) }),
      );
  return (
    <section className="card">
      <h2>Prompts</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        {(['system', 'intake', 'implementer', 'reviewer'] as const).map((m) => (
          <button
            key={m}
            className={`tab${m === mate ? ' active' : ''}`}
            onClick={() => setMate(m)}
          >
            {m}
          </button>
        ))}
        {view?.overridden ? <Chip tone="amber">overridden</Chip> : <Chip tone="gray">default</Chip>}
      </div>
      <p className="hint">Mustache templates; the required placeholders are validated on save.</p>
      <textarea
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`${mate} prompt`}
      />
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => void save(text)}>
          Save
        </button>
        <button className="btn" onClick={() => void save(null)} disabled={!view?.overridden}>
          Reset to default
        </button>
        {result && (
          <span className={result.ok ? 'result-ok' : 'result-fail'}>{result.message}</span>
        )}
      </div>
    </section>
  );
}

export function PricingTab() {
  const { settings, reload } = useSettings();
  const [rows, setRows] = useState(
    Object.entries(settings.pricing).map(([model, p]) => ({ model, ...p })),
  );
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const set = (i: number, k: string, v: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [k]: k === 'model' ? v : Number(v) } : r)));
  const save = () =>
    put(
      '/api/settings/pricing',
      Object.fromEntries(
        rows.filter((r) => r.model).map(({ model, ...p }) => [model, { ...p, currency: 'USD' }]),
      ),
    )
      .then(() => {
        setResult({ ok: true, message: 'Saved.' });
        return reload();
      })
      .catch((err: unknown) =>
        setResult({ ok: false, message: err instanceof ApiError ? err.message : String(err) }),
      );
  return (
    <section className="card">
      <h2>Pricing</h2>
      <p className="hint">
        USD per million tokens. Fill in from Anthropic's current price list; cost stays "reported
        only" for models missing here, and the UI flags a difference above 10 % between reported and
        computed.
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>Model</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache read</th>
            <th>Cache write</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  className="input"
                  value={r.model}
                  onChange={(e) => set(i, 'model', e.target.value)}
                  aria-label="Model"
                />
              </td>
              {(
                [
                  'input_per_mtok',
                  'output_per_mtok',
                  'cache_read_per_mtok',
                  'cache_write_per_mtok',
                ] as const
              ).map((k) => (
                <td key={k}>
                  <input
                    className="input"
                    type="number"
                    step="0.01"
                    value={r[k]}
                    onChange={(e) => set(i, k, e.target.value)}
                    aria-label={k}
                  />
                </td>
              ))}
              <td>
                <button
                  className="btn btn-sm"
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-actions">
        <button
          className="btn"
          onClick={() =>
            setRows([
              ...rows,
              {
                model: '',
                input_per_mtok: 0,
                output_per_mtok: 0,
                cache_read_per_mtok: 0,
                cache_write_per_mtok: 0,
                currency: 'USD',
              },
            ])
          }
        >
          Add model
        </button>
        <button className="btn btn-primary" onClick={() => void save()}>
          Save
        </button>
        {result && (
          <span className={result.ok ? 'result-ok' : 'result-fail'}>{result.message}</span>
        )}
      </div>
    </section>
  );
}

/** Who changed what (§10.5): the audit log, newest first, loaded in pages. */
export function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadMore = useCallback(async (before?: number) => {
    setBusy(true);
    try {
      const r = await get<{ entries: AuditEntry[] }>(
        `/api/settings/audit${qs({ before, limit: 100 })}`,
      );
      setEntries((prev) => (before ? [...prev, ...r.entries] : r.entries));
      setDone(r.entries.length < 100);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void loadMore();
  }, [loadMore]);
  const last = entries[entries.length - 1];
  return (
    <section className="card">
      <h2>Audit log</h2>
      <p className="hint">
        Every settings, credential, user and run action, with who did it. Entries live as long as
        the events retention window.
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>Target</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="muted">{formatDateTime(e.ts)}</td>
              <td>{e.actor}</td>
              <td>
                <code>{e.action.replace(/^audit\./, '')}</code>
              </td>
              <td>{e.target}</td>
              <td className="small muted">
                {Object.keys(e.details).length ? JSON.stringify(e.details) : ''}
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Nothing recorded yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {!done && last && (
        <button
          className="btn"
          type="button"
          disabled={busy}
          onClick={() => void loadMore(last.id)}
        >
          Load older
        </button>
      )}
    </section>
  );
}
