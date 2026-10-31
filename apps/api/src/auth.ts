/**
 * Authentication with Auth0 (review, Task 1). Auth0 signs short-lived access
 * tokens; the API only verifies them against the tenant's JWKS, issuer and audience.
 *
 * The Auth0 Post-Login Action (infra/auth0/post-login-action.js) adds these custom
 * claims, prefixed with AUTH_CLAIM_NAMESPACE (default "https://saas-rsa.app/"):
 *   user_id       our users.id (Auth0's `sub` is "sms|..." / "auth0|...", not ours)
 *   org_id        active organisation
 *   role          owner | payroll_admin | general_manager | shift_manager | employee | kiosk_device
 *   location_ids  locations the membership covers
 * It gets them from POST /internal/auth/claims (routes/internal-auth.ts).
 * Un-prefixed claims are also accepted, which is what local dev tokens use.
 */
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { ROLES, type Role, type TenantContext } from '@saas-rsa/db';
import type { Env } from './env';
import { HttpError } from './errors';

export type Verifier = (token: string) => Promise<TenantContext>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readClaims(payload: JWTPayload, namespace = 'https://saas-rsa.app/'): TenantContext {
  const raw = payload as Record<string, unknown>;
  const meta = (raw.app_metadata ?? {}) as Record<string, unknown>;
  const pick = (k: string) => raw[`${namespace}${k}`] ?? raw[k] ?? meta[k];

  const userId = pick('user_id') ?? payload.sub;
  const orgId = pick('org_id');
  const role = pick('role');
  const locationIds = pick('location_ids') ?? [];
  const invalid = (why: string) => new HttpError(401, 'invalid_token', why);

  if (typeof userId !== 'string' || !UUID.test(userId)) throw invalid('Token has no valid user_id');
  if (typeof orgId !== 'string' || !UUID.test(orgId)) throw invalid('Token has no valid org_id');
  if (typeof role !== 'string' || !ROLES.includes(role as Role)) throw invalid('Token has no valid role');
  if (!Array.isArray(locationIds) || !locationIds.every((l) => typeof l === 'string' && UUID.test(l))) {
    throw invalid('location_ids must be a list of ids');
  }
  return { userId, orgId, role: role as Role, locationIds };
}

export function createVerifier(env: Env): Verifier {
  const options = { audience: env.AUTH_AUDIENCE, ...(env.AUTH_ISSUER ? { issuer: env.AUTH_ISSUER } : {}) };
  const fail = () => {
    throw new HttpError(401, 'invalid_token', 'Token could not be verified');
  };
  if (env.AUTH_JWKS_URL) {
    const jwks = createRemoteJWKSet(new URL(env.AUTH_JWKS_URL));
    return async (token) => {
      const { payload } = await jwtVerify(token, jwks, { ...options, algorithms: ['RS256'] }).catch(fail);
      return readClaims(payload, env.AUTH_CLAIM_NAMESPACE);
    };
  }
  const secret = new TextEncoder().encode(env.AUTH_DEV_SECRET);
  return async (token) => {
    const { payload } = await jwtVerify(token, secret, { ...options, algorithms: ['HS256'] }).catch(fail);
    return readClaims(payload, env.AUTH_CLAIM_NAMESPACE);
  };
}

/** Local development and tests only: mint a 15-minute token signed with the dev secret. */
export async function signDevToken(ctx: TenantContext, secret: string, audience = 'saas-rsa-api'): Promise<string> {
  return new SignJWT({ user_id: ctx.userId, org_id: ctx.orgId, role: ctx.role, location_ids: ctx.locationIds })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`dev|${ctx.userId}`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret));
}
