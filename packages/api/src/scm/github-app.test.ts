import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { GitHubAppAuth } from './github-app.js';

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

/** Captures token requests and answers like GitHub's installation endpoint. */
function fakeGitHub(expiresInMs: number, now: () => number) {
  const calls: { url: string; authorization: string }[] = [];
  let seq = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const headers = init?.headers as Record<string, string>;
    calls.push({ url: requestUrl(input), authorization: headers.authorization ?? '' });
    seq += 1;
    return new Response(
      JSON.stringify({
        token: `ghs_${seq}`,
        expires_at: new Date(now() + expiresInMs).toISOString(),
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };
  return { calls, fetch: fetchFn };
}

describe('GitHubAppAuth', () => {
  let pem = '';
  let spki = '';
  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    pem = await exportPKCS8(privateKey);
    spki = await exportSPKI(publicKey);
  });

  it('signs an app JWT with the App id as issuer and a sub-ten-minute lifetime', async () => {
    const auth = new GitHubAppAuth({
      baseUrl: 'https://github.com',
      appId: '12345',
      installationId: '42',
      privateKeyPem: pem,
    });
    const { payload, protectedHeader } = await jwtVerify(
      await auth.appJwt(),
      await importSPKI(spki, 'RS256'),
      { issuer: '12345' },
    );
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600);
  });

  it('exchanges the JWT for an installation token and caches it until near expiry', async () => {
    let clock = Date.parse('2026-10-19T10:00:00Z');
    const now = () => clock;
    const gh = fakeGitHub(3_600_000, now);
    const auth = new GitHubAppAuth({
      baseUrl: 'https://ghe.example.com',
      appId: '1',
      installationId: '42',
      privateKeyPem: pem,
      fetch: gh.fetch,
      now,
    });

    expect(await auth.installationToken()).toBe('ghs_1');
    expect(gh.calls[0]!.url).toBe(
      'https://ghe.example.com/api/v3/app/installations/42/access_tokens',
    );
    expect(gh.calls[0]!.authorization).toMatch(/^Bearer eyJ/);

    clock += 50 * 60_000;
    expect(await auth.installationToken()).toBe('ghs_1');
    expect(gh.calls).toHaveLength(1);

    clock += 6 * 60_000; // inside the five-minute renewal margin
    expect(await auth.installationToken()).toBe('ghs_2');
    expect(gh.calls).toHaveLength(2);
  });

  it('mints once when several callers race for the first token', async () => {
    const gh = fakeGitHub(3_600_000, Date.now);
    const auth = new GitHubAppAuth({
      baseUrl: 'https://github.com',
      appId: '1',
      installationId: '42',
      privateKeyPem: pem,
      fetch: gh.fetch,
    });
    const tokens = await Promise.all([
      auth.installationToken(),
      auth.installationToken(),
      auth.installationToken(),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(gh.calls).toHaveLength(1);
  });
});
