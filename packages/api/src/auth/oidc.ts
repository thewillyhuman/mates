import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import type { Pool } from '../db/pool.js';
import { countUsers, createUser, findUserByEmail, type Role, type User } from './users.js';

/**
 * OIDC sign-in (§10.4): authorization code flow with PKCE against any
 * compliant issuer. The first OIDC user on an empty instance becomes
 * admin (§6.1); afterwards roles come from the group mapping, default
 * viewer. The client secret comes from the credentials Secret.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  groupsClaim: string;
  groups: { admin: string[]; operator: string[] };
  fetch?: typeof fetch | undefined;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  issuer: string;
}

export interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

export class OidcError extends Error {}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function roleFromGroups(groups: readonly string[], mapping: OidcConfig['groups']): Role {
  if (groups.some((g) => mapping.admin.includes(g))) return 'admin';
  if (groups.some((g) => mapping.operator.includes(g))) return 'operator';
  return 'viewer';
}

export class OidcClient {
  private discovery: Discovery | undefined;
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly cfg: OidcConfig) {
    this.fetchFn = cfg.fetch ?? fetch;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new OidcError(`OIDC discovery failed: HTTP ${res.status} from ${url}`);
    this.discovery = (await res.json()) as Discovery;
    this.jwks = createRemoteJWKSet(new URL(this.discovery.jwks_uri), {
      [customFetch]: this.fetchFn as never,
    });
    return this.discovery;
  }

  /** Builds the authorization URL and the values to keep in the login cookie. */
  async start(returnTo = '/'): Promise<{ url: string; pending: PendingLogin }> {
    const d = await this.discover();
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scopes,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return {
      url: `${d.authorization_endpoint}${d.authorization_endpoint.includes('?') ? '&' : '?'}${params.toString()}`,
      pending: { state, nonce, verifier, returnTo },
    };
  }

  /** Exchanges the code, verifies the id_token and returns the identity. */
  async callback(
    query: {
      code?: string | undefined;
      state?: string | undefined;
      error?: string | undefined;
      error_description?: string | undefined;
    },
    pending: PendingLogin,
  ): Promise<{ email: string; name: string; groups: string[] }> {
    if (query.error)
      throw new OidcError(`provider error: ${query.error_description ?? query.error}`);
    if (!query.code || query.state !== pending.state) throw new OidcError('state mismatch');
    const d = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: query.code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: pending.verifier,
    });
    const res = await this.fetchFn(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok)
      throw new OidcError(
        `token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
      );
    const tokens = (await res.json()) as { id_token?: string; access_token?: string };
    if (!tokens.id_token) throw new OidcError('no id_token in the token response');
    const { payload } = await jwtVerify(tokens.id_token, this.jwks!, {
      issuer: d.issuer,
      audience: this.cfg.clientId,
    });
    if (payload.nonce !== pending.nonce) throw new OidcError('nonce mismatch');
    let claims: JWTPayload & { email?: string; name?: string; preferred_username?: string } =
      payload;
    if (!claims.email && d.userinfo_endpoint && tokens.access_token) {
      const ui = await this.fetchFn(d.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (ui.ok) claims = { ...claims, ...((await ui.json()) as object) };
    }
    const email = (claims.email ?? claims.preferred_username ?? '').toLowerCase();
    if (!email) throw new OidcError('the identity has no email claim');
    const groups = Array.isArray(claims[this.cfg.groupsClaim])
      ? (claims[this.cfg.groupsClaim] as unknown[]).map(String)
      : [];
    return { email, name: claims.name ?? email.split('@')[0] ?? email, groups };
  }

  /** Finds or creates the local user for an identity; first user ever becomes admin. */
  async upsertUser(
    db: Pool,
    identity: { email: string; name: string; groups: string[] },
  ): Promise<User> {
    const existing = await findUserByEmail(db, identity.email);
    const mapped = roleFromGroups(identity.groups, this.cfg.groups);
    if (existing) {
      if (
        existing.auth === 'oidc' &&
        existing.role !== mapped &&
        (this.cfg.groups.admin.length || this.cfg.groups.operator.length)
      ) {
        await db.query('UPDATE users SET role = $2 WHERE id = $1', [existing.id, mapped]);
        return { ...existing, role: mapped };
      }
      return existing;
    }
    const first = (await countUsers(db)) === 0;
    return createUser(db, {
      email: identity.email,
      displayName: identity.name,
      role: first ? 'admin' : mapped,
      auth: 'oidc',
    });
  }
}
