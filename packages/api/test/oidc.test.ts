import fastify, { type FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OidcClient, roleFromGroups } from '../src/auth/oidc.js';
import { stopTestDatabase } from './db.js';
import { testApp, type TestApp } from './harness.js';

/** A minimal OpenID provider: discovery, JWKS, token endpoint (checks PKCE), userinfo. */
async function fakeIssuer(opts: { email: string; groups: string[] }): Promise<{
  app: FastifyInstance;
  issuer: string;
  codes: Map<string, { nonce: string; challenge: string }>;
  close: () => Promise<void>;
}> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const app = fastify();
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  );
  const codes = new Map<string, { nonce: string; challenge: string }>();
  let issuer = '';
  app.get('/.well-known/openid-configuration', async () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    userinfo_endpoint: `${issuer}/userinfo`,
  }));
  app.get('/jwks', async () => ({ keys: [jwk] }));
  app.post('/token', async (req, reply) => {
    const body = Object.fromEntries(new URLSearchParams(req.body as string));
    const entry = codes.get(body.code ?? '');
    if (!entry || body.client_secret !== 'shh' || body.client_id !== 'mates')
      return reply.status(400).send({ error: 'invalid_grant' });
    const { createHash } = await import('node:crypto');
    if (
      createHash('sha256')
        .update(body.code_verifier ?? '')
        .digest('base64url') !== entry.challenge
    )
      return reply.status(400).send({ error: 'invalid_grant', error_description: 'pkce' });
    const idToken = await new SignJWT({
      nonce: entry.nonce,
      groups: opts.groups,
      name: 'Ana Keller',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(issuer)
      .setAudience('mates')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return { id_token: idToken, access_token: 'at', token_type: 'Bearer' };
  });
  app.get('/userinfo', async () => ({ email: opts.email }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  issuer = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { app, issuer, codes, close: () => app.close() };
}

describe('roleFromGroups', () => {
  it('maps groups to roles with viewer as the default', () => {
    const m = { admin: ['mates-admins'], operator: ['dev'] };
    expect(roleFromGroups(['dev', 'mates-admins'], m)).toBe('admin');
    expect(roleFromGroups(['dev'], m)).toBe('operator');
    expect(roleFromGroups(['other'], m)).toBe('viewer');
  });
});

describe('OIDC login', () => {
  let t: TestApp;
  let idp: Awaited<ReturnType<typeof fakeIssuer>>;
  beforeAll(async () => {
    idp = await fakeIssuer({ email: 'ana@example.com', groups: ['dev'] });
    t = await testApp({
      helm: {
        oidc: {
          enabled: true,
          issuer: idp.issuer,
          clientId: 'mates',
          scopes: 'openid email',
          groupsClaim: 'groups',
          groups: { admin: ['mates-admins'], operator: ['dev'] },
        },
      },
    });
    await t.credentials.set('oidc_client_secret', 'shh', 'admin@example.com');
  });
  afterAll(async () => {
    await t.close();
    await idp.close();
    await stopTestDatabase();
  });

  it('completes the code flow with PKCE and signs the user in with the mapped role', async () => {
    expect((await t.app.inject({ url: '/api/auth/oidc/config' })).json()).toEqual({
      enabled: true,
    });
    const start = await t.app.inject({ url: '/api/auth/oidc/start?return_to=/runs' });
    expect(start.statusCode).toBe(302);
    const location = new URL(start.headers.location!);
    expect(location.origin).toBe(idp.issuer);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    const loginCookie = start.cookies.find((c) => c.name === 'mates_oidc')!;
    expect(loginCookie.httpOnly).toBe(true);

    // The "user" authenticates at the provider, which issues a code bound to the nonce and challenge.
    const pending = JSON.parse(Buffer.from(loginCookie.value, 'base64url').toString()) as {
      state: string;
      nonce: string;
    };
    idp.codes.set('code-1', {
      nonce: pending.nonce,
      challenge: location.searchParams.get('code_challenge')!,
    });

    const cb = await t.app.inject({
      url: `/api/auth/oidc/callback?code=code-1&state=${pending.state}`,
      headers: { cookie: `mates_oidc=${loginCookie.value}` },
    });
    expect(cb.statusCode, cb.body).toBe(302);
    expect(cb.headers.location).toBe('/runs');
    const session = cb.cookies.find((c) => c.name === 'mates_session')!;
    const me = await t.app.inject({
      url: '/api/auth/me',
      headers: { cookie: `mates_session=${session.value}` },
    });
    expect(me.json()).toMatchObject({
      email: 'ana@example.com',
      displayName: 'Ana Keller',
      role: 'operator',
      auth: 'oidc',
    });

    const bad = await t.app.inject({
      url: `/api/auth/oidc/callback?code=code-1&state=wrong`,
      headers: { cookie: `mates_oidc=${loginCookie.value}` },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('makes the very first user an admin on an empty instance', async () => {
    const empty = await testApp({
      helm: {
        oidc: {
          enabled: true,
          issuer: idp.issuer,
          clientId: 'mates',
          scopes: 'openid',
          groupsClaim: 'groups',
          groups: { admin: [], operator: [] },
        },
      },
    });
    try {
      await empty.db.pool.query('DELETE FROM users');
      await empty.credentials.set('oidc_client_secret', 'shh', 'system');
      const client = new OidcClient({
        issuer: idp.issuer,
        clientId: 'mates',
        clientSecret: 'shh',
        scopes: 'openid',
        redirectUri: 'http://x/cb',
        groupsClaim: 'groups',
        groups: { admin: [], operator: [] },
      });
      const user = await client.upsertUser(empty.db.pool, {
        email: 'first@example.com',
        name: 'First',
        groups: [],
      });
      expect(user.role).toBe('admin');
      const second = await client.upsertUser(empty.db.pool, {
        email: 'second@example.com',
        name: 'Second',
        groups: [],
      });
      expect(second.role).toBe('viewer');
    } finally {
      await empty.close();
    }
  });
});
