import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router';
import { get } from '../../api/client.js';
import { useAuth } from '../../api/auth.js';
import type { CredentialStatus, TeamContextVersion } from '../../api/types.js';
import { Chip } from '../../components/ui.js';
import { SettingsProvider, useSettings } from './common.js';
import {
  AnthropicTab,
  JiraTab,
  ModelsTab,
  NotificationsTab,
  PricingTab,
  PromptsTab,
  RunnerTab,
  ScmTab,
  TeamContextTab,
  TokensTab,
  UsersTab,
} from './tabs.js';

/** Settings (§13.6): wizard steps as tabs, plus users, tokens, prompts, pricing. */
const TABS = [
  { path: 'anthropic', label: '1 · Anthropic', el: <AnthropicTab /> },
  { path: 'jira', label: '2 · Jira', el: <JiraTab /> },
  { path: 'scm', label: '3 · Source control', el: <ScmTab /> },
  { path: 'team-context', label: '4 · Team context', el: <TeamContextTab /> },
  { path: 'models', label: '5 · Models & budgets', el: <ModelsTab /> },
  { path: 'runner', label: '6 · Runner', el: <RunnerTab /> },
  { path: 'notifications', label: '7 · Notifications', el: <NotificationsTab /> },
  { path: 'users', label: 'Users', el: <UsersTab /> },
  { path: 'tokens', label: 'API tokens', el: <TokensTab /> },
  { path: 'prompts', label: 'Prompts', el: <PromptsTab /> },
  { path: 'pricing', label: 'Pricing', el: <PricingTab /> },
];

/** The wizard's last page: what is still red (§6.2). */
function Checklist() {
  const { settings } = useSettings();
  const [creds, setCreds] = useState<Record<string, CredentialStatus>>({});
  const [tc, setTc] = useState<TeamContextVersion | null | undefined>(undefined);
  useEffect(() => {
    const names = [
      'anthropic_api_key',
      'jira_token',
      ...settings.scm.providers.map((p) => `scm_${p.id}_token`),
    ];
    void Promise.all(
      names.map((n) => get<CredentialStatus>(`/api/settings/credentials/${n}`).catch(() => null)),
    ).then((rs) =>
      setCreds(
        Object.fromEntries(
          rs.filter((r): r is CredentialStatus => r !== null).map((r) => [r.name, r]),
        ),
      ),
    );
    void get<{ active: TeamContextVersion | null }>('/api/settings/team-context').then((r) =>
      setTc(r.active),
    );
  }, [settings]);
  const items: { label: string; ok: boolean; to: string; why: string }[] = [
    {
      label: 'Anthropic',
      ok: settings.anthropic.provider !== 'api_key' || Boolean(creds.anthropic_api_key?.set),
      to: 'anthropic',
      why: 'API key not stored',
    },
    {
      label: 'Jira',
      ok: Boolean(settings.jira.base_url && creds.jira_token?.set && settings.jira.trigger.value),
      to: 'jira',
      why: 'base URL, token or trigger rule missing',
    },
    {
      label: 'Source control',
      ok:
        settings.scm.providers.length > 0 &&
        settings.scm.providers.every((p) => creds[`scm_${p.id}_token`]?.set),
      to: 'scm',
      why: 'no provider with a stored token',
    },
    { label: 'Team context', ok: Boolean(tc), to: 'team-context', why: 'no valid package active' },
  ];
  const red = items.filter((i) => !i.ok);
  return (
    <section className="card">
      <h2>Setup checklist</h2>
      <p className="hint">
        Ten minutes from <code>helm install</code> to the first run: complete the steps that are
        still red.
      </p>
      <table className="data">
        <tbody>
          {items.map((i) => (
            <tr key={i.label}>
              <td>{i.label}</td>
              <td>{i.ok ? <Chip tone="green">ok</Chip> : <Chip tone="red">{i.why}</Chip>}</td>
              <td>
                <NavLink to={`/settings/${i.to}`}>Open</NavLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {red.length === 0 && (
        <p className="result-ok">
          Everything is configured. Assign a ticket to Mates in Jira or start a run from the API.
        </p>
      )}
    </section>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  if (user?.role !== 'admin') {
    return <SettingsNonAdmin />;
  }
  return (
    <SettingsProvider>
      <div className="page-title">
        <h1>Settings</h1>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav card" aria-label="Settings sections">
          <NavLink to="/settings" end>
            Checklist
          </NavLink>
          {TABS.map((t) => (
            <NavLink key={t.path} to={`/settings/${t.path}`}>
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div>
          <Routes>
            <Route index element={<Checklist />} />
            {TABS.map((t) => (
              <Route key={t.path} path={t.path} element={t.el} />
            ))}
            <Route path="*" element={<Navigate to="/settings" replace />} />
          </Routes>
        </div>
      </div>
    </SettingsProvider>
  );
}

function SettingsNonAdmin() {
  return (
    <>
      <div className="page-title">
        <h1>Settings</h1>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav card" aria-label="Settings sections">
          <NavLink to="/settings/tokens">API tokens</NavLink>
          <NavLink to="/settings/prompts">Prompts (read-only)</NavLink>
        </nav>
        <div>
          <Routes>
            <Route path="tokens" element={<TokensTab />} />
            <Route path="prompts" element={<PromptsReadOnly />} />
            <Route path="*" element={<Navigate to="/settings/tokens" replace />} />
          </Routes>
        </div>
      </div>
    </>
  );
}

function PromptsReadOnly() {
  return (
    <section className="card">
      <h2>Prompts</h2>
      <p className="hint">
        Prompts are shown on the Mates page; editing them needs the admin role.
      </p>
    </section>
  );
}
