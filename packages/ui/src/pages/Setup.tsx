import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError, get } from '../api/client.js';
import { useAuth } from '../api/auth.js';
import { OidcButton } from './Login.js';

/** First-run page (§6.1): setup token → first admin. Disabled once an admin exists. */
export function SetupPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [oidc, setOidc] = useState(false);
  useEffect(() => {
    void get<{ enabled: boolean }>('/api/auth/oidc/config')
      .then((r) => setOidc(r.enabled))
      .catch(() => setOidc(false));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('POST', '/api/setup/bootstrap', { token, email, password });
      await refresh();
      void navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={(e) => void submit(e)}>
        <h1>Set up Mates</h1>
        <p className="lead">
          Paste the setup token printed by the chart notes, then create the first admin.
        </p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="token">Setup token</label>
          <input
            id="token"
            className="input mono"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            required
          />
          <span className="hint mono">
            kubectl get secret mates-bootstrap -o jsonpath=&#123;.data.token&#125; | base64 -d
          </span>
        </div>
        <div className="field">
          <label htmlFor="email">Admin email</label>
          <input
            id="email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <span className="hint">At least 10 characters.</span>
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Create admin
        </button>
        {oidc && (
          <>
            <OidcButton returnTo="/" />
            <span className="hint">The first person to sign in with OIDC becomes the admin.</span>
          </>
        )}
      </form>
    </div>
  );
}
