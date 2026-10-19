import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { TeamManifest } from '@mates/core';
import { get } from '../api/client.js';
import type { PromptView, Settings, TeamContextVersion } from '../api/types.js';
import { Chip, ErrorBox } from '../components/ui.js';
import { formatDateTime, formatDuration, formatUsd } from '../lib/format.js';

/** Mates page (§13.5): the three mates and the active team context. */
const MATES = ['intake', 'implementer', 'reviewer'] as const;
const PERMISSIONS: Record<(typeof MATES)[number], string> = {
  intake: 'Read, Glob, Grep, Bash(git log *), Bash(git ls-files *) · dontAsk',
  implementer:
    'Read, Edit, Write, Glob, Grep, Bash(git *), setup/test/lint, pnpm/npm/pip/pytest/make · acceptEdits · never git push',
  reviewer:
    'Read, Glob, Grep, Bash(git diff *), Bash(git log *), test command · dontAsk · never edits',
};

export function MatesPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [prompts, setPrompts] = useState<Record<string, PromptView>>({});
  const [tc, setTc] = useState<{
    active: TeamContextVersion | null;
    versions: TeamContextVersion[];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, t, ...p] = await Promise.all([
          get<{ settings: Settings }>('/api/settings').catch(() => null),
          get<{ active: TeamContextVersion | null; versions: TeamContextVersion[] }>(
            '/api/settings/team-context',
          ),
          ...[...MATES, 'system' as const].map((m) =>
            get<PromptView>(`/api/settings/prompts/${m}`),
          ),
        ]);
        if (s) setSettings(s.settings);
        setTc(t);
        setPrompts(Object.fromEntries(p.map((x) => [x.name, x])));
      } catch (err) {
        setError(err);
      }
    })();
  }, []);

  const manifest = tc?.active?.manifest as TeamManifest | null | undefined;
  return (
    <>
      <div className="page-title">
        <h1>Mates</h1>
      </div>
      <ErrorBox error={error} />
      {!settings && (
        <div className="banner banner-blue">
          Models and budgets are visible to admins; ask one to adjust them under Settings.
        </div>
      )}
      <div className="stats-strip" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        {MATES.map((m) => {
          const cfg = settings?.mates[m];
          return (
            <div className="card" key={m}>
              <div className="section-title">{m.toUpperCase()}</div>
              {cfg && (
                <>
                  <div>
                    <Chip mono>{cfg.model}</Chip> {cfg.effort && <Chip>effort {cfg.effort}</Chip>}
                  </div>
                  <p className="small muted">
                    Budget {formatUsd(cfg.max_budget_usd)} per invocation · {cfg.max_turns} turns ·
                    timeout {formatDuration(cfg.timeout_seconds * 1000)}
                  </p>
                </>
              )}
              <p className="small">
                <strong>Permissions.</strong> {PERMISSIONS[m]}
              </p>
              <details>
                <summary>
                  Prompt{' '}
                  {prompts[m]?.overridden ? (
                    <Chip tone="amber">overridden</Chip>
                  ) : (
                    <Chip tone="gray">default</Chip>
                  )}
                </summary>
                <pre className="tail" style={{ height: 'auto', maxHeight: 360, color: '#d7dce3' }}>
                  {prompts[m]?.template ?? '…'}
                </pre>
                <Link to={`/settings/prompts`} className="small">
                  Edit under Settings → Prompts
                </Link>
              </details>
            </div>
          );
        })}
      </div>
      <section className="card">
        <div className="row spread">
          <div className="section-title">TEAM CONTEXT</div>
          {tc?.active && (
            <span className="muted small">
              v{tc.active.version} · {tc.active.source} · {formatDateTime(tc.active.fetchedAt)}
            </span>
          )}
        </div>
        {!manifest && (
          <div className="empty">
            No active team context. Upload one under Settings → Team context.
          </div>
        )}
        {manifest && (
          <>
            <p>
              <strong>{manifest.team.name}</strong> · conventions:{' '}
              {manifest.team.conventions.map((c) => (
                <code key={c}>{c} </code>
              ))}{' '}
              · branches <code>{manifest.branching.pattern}</code>
              {manifest.review.max_iterations
                ? ` · max ${manifest.review.max_iterations} iterations`
                : ''}
            </p>
            <table className="data">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>Provider</th>
                  <th>Project</th>
                  <th>Jira projects</th>
                  <th>Setup</th>
                  <th>Test</th>
                </tr>
              </thead>
              <tbody>
                {manifest.repos.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.id}</strong>
                      <div className="muted small">{r.about}</div>
                    </td>
                    <td>{r.scm}</td>
                    <td className="mono">{r.project}</td>
                    <td>{r.jira_projects.join(', ')}</td>
                    <td className="mono small">{r.setup || '—'}</td>
                    <td className="mono small">{r.test || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tc && tc.versions.length > 1 && (
          <details style={{ marginTop: 12 }}>
            <summary>Version history ({tc.versions.length})</summary>
            <table className="data">
              <tbody>
                {tc.versions.map((v) => (
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
                      {v.errors.length ? (
                        <ul>
                          {v.errors.map((e) => (
                            <li key={e} className="small tone-red">
                              {e}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        `${(v.manifest as TeamManifest | null)?.repos.length ?? 0} repos`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>
    </>
  );
}
