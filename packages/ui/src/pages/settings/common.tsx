import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, get, post, put } from '../../api/client.js';
import type { CredentialStatus, Settings, SettingsResponse } from '../../api/types.js';
import { ErrorBox } from '../../components/ui.js';
import { formatDateTime } from '../../lib/format.js';

/** Shared state and widgets for the settings tabs (§13.6). */
interface SettingsState {
  settings: Settings;
  managed: string[];
  isManaged: (path: string) => boolean;
  save: (patch: Partial<Settings>) => Promise<string[]>;
  reload: () => Promise<void>;
}

const Ctx = createContext<SettingsState | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    try {
      setData(await get<SettingsResponse>('/api/settings'));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const value = useMemo<SettingsState | undefined>(
    () =>
      data
        ? {
            settings: data.settings,
            managed: data.managed,
            isManaged: (path) => data.managed.some((m) => m === path || path.startsWith(`${m}.`)),
            save: async (patch) => {
              const r = await put<SettingsResponse>('/api/settings', patch);
              setData(r);
              return r.ignored ?? [];
            },
            reload,
          }
        : undefined,
    [data, reload],
  );
  if (error) return <ErrorBox error={error} />;
  if (!value) return <div className="muted">Loading settings…</div>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSettings outside SettingsProvider');
  return ctx;
}

/** A labelled input bound to a draft; disabled with a badge when Helm manages it. */
export function Field({
  label,
  path,
  value,
  onChange,
  type = 'text',
  hint,
  options,
  placeholder,
}: {
  label: string;
  path: string;
  value: string | number | boolean;
  onChange: (v: string) => void;
  type?: 'text' | 'number' | 'password' | 'url' | 'checkbox' | 'select' | 'textarea';
  hint?: ReactNode;
  options?: { value: string; label: string }[];
  placeholder?: string;
}) {
  const { isManaged } = useSettings();
  const managed = isManaged(path);
  const id = `f-${path.replace(/\W/g, '-')}`;
  const badge = managed && <span className="badge-helm">managed by Helm</span>;
  if (type === 'checkbox') {
    return (
      <label className="row small" style={{ marginBottom: 10 }} htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          disabled={managed}
          onChange={(e) => onChange(String(e.target.checked))}
        />{' '}
        {label}
        {badge}
      </label>
    );
  }
  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {badge}
      </label>
      {type === 'select' ? (
        <select
          id={id}
          className="input"
          value={String(value)}
          disabled={managed}
          onChange={(e) => onChange(e.target.value)}
        >
          {options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : type === 'textarea' ? (
        <textarea
          id={id}
          className="input"
          value={String(value)}
          disabled={managed}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      ) : (
        <input
          id={id}
          className="input"
          type={type}
          value={String(value)}
          disabled={managed}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Save button with the result line; `ignored` names the Helm-managed keys that were dropped. */
export function SaveBar({
  onSave,
  busy,
  result,
}: {
  onSave: () => void;
  busy: boolean;
  result: { ok: boolean; message: string } | null;
}) {
  return (
    <div className="form-actions">
      <button className="btn btn-primary" type="button" onClick={onSave} disabled={busy}>
        Save
      </button>
      {result && <span className={result.ok ? 'result-ok' : 'result-fail'}>{result.message}</span>}
    </div>
  );
}

export function useSave(section: keyof Settings) {
  const { save } = useSettings();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const run = async (draft: unknown) => {
    setBusy(true);
    try {
      const ignored = await save({ [section]: draft } as Partial<Settings>);
      setResult({
        ok: true,
        message: ignored.length ? `Saved. Ignored Helm-managed: ${ignored.join(', ')}` : 'Saved.',
      });
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, run };
}

/** A credential stored in the release Secret: status, set a new value, Test (§6.2). */
export function CredentialField({
  name,
  label,
  hint,
  test = true,
  multiline = false,
}: {
  name: string;
  label: string;
  hint?: ReactNode;
  test?: boolean;
  /** Textarea instead of a password input, for PEM keys that must keep their line breaks. */
  multiline?: boolean;
}) {
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    message: string;
    details?: Record<string, unknown>;
  } | null>(null);
  const load = useCallback(
    () =>
      get<CredentialStatus>(`/api/settings/credentials/${name}`)
        .then(setStatus)
        .catch(() => setStatus(null)),
    [name],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const readOnly = status?.read_only ?? false;
  return (
    <div className="field" data-testid={`credential-${name}`}>
      <label htmlFor={`c-${name}`}>
        {label}{' '}
        {status && (
          <span className={`small ${status.set ? 'result-ok' : 'muted'}`}>
            · {status.set ? 'set' : 'not set'}
            {status.last_validated_at
              ? ` · validated ${formatDateTime(status.last_validated_at)}`
              : ''}
            {readOnly ? ' · managed by an existing Secret' : ''}
          </span>
        )}
      </label>
      <div className="row">
        {multiline ? (
          <textarea
            id={`c-${name}`}
            className="input"
            rows={4}
            style={{ maxWidth: 420, fontFamily: 'monospace' }}
            value={value}
            disabled={readOnly}
            onChange={(e) => setValue(e.target.value)}
            placeholder={status?.set ? '(stored; paste a new key to replace)' : 'paste the PEM key'}
            autoComplete="off"
          />
        ) : (
          <input
            id={`c-${name}`}
            className="input"
            type="password"
            style={{ maxWidth: 420 }}
            value={value}
            disabled={readOnly}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              status?.set ? '•••••••• (stored; enter a new value to replace)' : 'paste the value'
            }
            autoComplete="off"
          />
        )}
        <button
          className="btn"
          type="button"
          disabled={!value || readOnly || busy}
          onClick={() =>
            void (async () => {
              setBusy(true);
              try {
                await put(`/api/settings/credentials/${name}`, { value });
                setValue('');
                await load();
                setResult({ ok: true, message: 'Stored in the Kubernetes Secret.' });
              } catch (err) {
                setResult({
                  ok: false,
                  message: err instanceof ApiError ? err.message : String(err),
                });
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          Store
        </button>
        {test && (
          <button
            className="btn"
            type="button"
            disabled={busy}
            data-testid={`test-${name}`}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setResult(null);
                try {
                  const r = await post<{
                    ok: boolean;
                    message: string;
                    details: Record<string, unknown>;
                  }>(`/api/settings/credentials/${name}/test`);
                  setResult(r);
                  await load();
                } catch (err) {
                  setResult({
                    ok: false,
                    message: err instanceof ApiError ? err.message : String(err),
                  });
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Test
          </button>
        )}
      </div>
      {hint && <span className="hint">{hint}</span>}
      {result && (
        <div className={`small ${result.ok ? 'result-ok' : 'result-fail'}`} role="status">
          {result.ok ? '✓' : '✗'} {result.message}
          {result.details && Object.keys(result.details).length > 0 && (
            <details>
              <summary>details</summary>
              <pre className="small">{JSON.stringify(result.details, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
