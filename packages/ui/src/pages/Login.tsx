import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, ApiError, get } from '../api/client.js';
import { useAuth } from '../api/auth.js';

/** Sign-in (§10.4): local password, or the organisation's OIDC provider when the chart enables it. */
export function LoginPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [oidc, setOidc] = useState(false);
  const next = (location.state as { from?: string } | null)?.from ?? '/';

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
      await api('POST', '/api/auth/login', { email, password });
      await refresh();
      void navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={(e) => void submit(e)}>
        <h1>Sign in to Mates</h1>
        <p className="lead">Use your email and password.</p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          Sign in
        </button>
        {oidc && <OidcButton returnTo={next} />}
      </form>
    </div>
  );
}

/** A plain link: the API starts the authorization code flow and redirects back. */
export function OidcButton({ returnTo }: { returnTo: string }) {
  return (
    <a
      className="btn"
      style={{ marginLeft: 8 }}
      href={`/api/auth/oidc/start?return_to=${encodeURIComponent(returnTo)}`}
    >
      Sign in with OIDC
    </a>
  );
}
