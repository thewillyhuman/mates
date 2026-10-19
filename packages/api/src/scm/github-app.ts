import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { HttpClient } from '../http-client.js';
import { githubApiBase } from './github.js';

/**
 * GitHub App authentication (§8.5): signs a short-lived app JWT with the
 * App's private key and exchanges it for an installation access token,
 * which GitHub scopes to the installation's repositories and expires
 * after one hour. Tokens are cached and renewed five minutes before expiry,
 * so a provider mints at most one token per hour in steady state.
 */
export interface GitHubAppOptions {
  baseUrl: string;
  appId: string;
  installationId: string;
  /** PEM private key as downloaded from GitHub (PKCS#1 or PKCS#8). */
  privateKeyPem: string;
  fetch?: typeof fetch | undefined;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/** Renew this long before GitHub's `expires_at`. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** App JWTs may live at most ten minutes; use nine, backdated a minute for clock skew. */
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 9 * 60;

export class GitHubAppAuth {
  private readonly http: HttpClient;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(private readonly opts: GitHubAppOptions) {
    this.now = opts.now ?? Date.now;
    this.http = new HttpClient({
      baseUrl: githubApiBase(opts.baseUrl),
      headers: { 'x-github-api-version': '2022-11-28', 'user-agent': 'mates' },
      fetch: opts.fetch,
    });
  }

  /** A valid installation token, minted on first use and renewed near expiry. */
  async installationToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - RENEW_MARGIN_MS > this.now())
      return this.cached.token;
    this.inflight ??= this.mint().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** The app JWT GitHub accepts on `/app/*` endpoints. */
  async appJwt(): Promise<string> {
    const nowS = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.opts.appId)
      .setIssuedAt(nowS - JWT_BACKDATE_S)
      .setExpirationTime(nowS + JWT_LIFETIME_S)
      .sign(createPrivateKey(this.opts.privateKeyPem));
  }

  private async mint(): Promise<string> {
    const jwt = await this.appJwt();
    const res = await this.http.json<{ token: string; expires_at: string }>(
      'POST',
      `/app/installations/${encodeURIComponent(this.opts.installationId)}/access_tokens`,
      undefined,
      { authorization: `Bearer ${jwt}` },
    );
    const expiresAt = Date.parse(res.expires_at);
    this.cached = {
      token: res.token,
      expiresAt: Number.isNaN(expiresAt) ? this.now() + 3_600_000 : expiresAt,
    };
    return res.token;
  }
}
