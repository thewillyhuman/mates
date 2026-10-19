import { jwtVerify, SignJWT } from 'jose';

/**
 * Per-invocation JWT (§10.2): HS256 with the internal key, audience
 * `mates-runner`, subject = invocation id. Minted at spawn time with
 * expiry = invocation timeout + 10 minutes; verified by the internal
 * ingest/blob/context endpoints.
 */
export const INVOCATION_AUDIENCE = 'mates-runner';

export interface InvocationClaims {
  invocationId: string;
  runId: string;
}

export class InvalidInvocationTokenError extends Error {}

export async function mintInvocationToken(
  key: string,
  claims: InvocationClaims,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ run_id: claims.runId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.invocationId)
    .setAudience(INVOCATION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(new TextEncoder().encode(key));
}

export async function verifyInvocationToken(key: string, token: string): Promise<InvocationClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(key), {
      audience: INVOCATION_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string' || typeof payload.run_id !== 'string') {
      throw new InvalidInvocationTokenError('token lacks subject or run_id');
    }
    return { invocationId: payload.sub, runId: payload.run_id };
  } catch (err) {
    if (err instanceof InvalidInvocationTokenError) throw err;
    throw new InvalidInvocationTokenError(`invalid invocation token: ${(err as Error).message}`);
  }
}
