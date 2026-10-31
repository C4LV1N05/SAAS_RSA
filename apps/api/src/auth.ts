/**
 * Authentication (review, Task 1). The API never issues long-lived tokens itself:
 * a managed identity provider (Supabase Auth, Clerk, Auth0 or Cognito) signs short
 * access tokens, and the API only verifies them against the provider's JWKS.
 *
 * Expected claims (top level or under `app_metadata`):
 *   sub           user id (matches users.id)
 *   org_id        active organisation
 *   role          owner | payroll_admin | general_manager | shift_manager | employee | kiosk_device
 *   location_ids  locations the membership covers
 * The provider fills these from the memberships table at sign-in
 * (see app.memberships_for_user in db/migrations/0005_rls.sql).
 */
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { ROLES, type Role, type TenantContext } from '@saas-rsa/db';
import type { Env } from './env';
import { HttpError } from './errors';

export type Verifier = (token: string) => Promise<TenantContext>;

function readClaims(payload: JWTPayload): TenantContext {
  const meta = (payload.app_metadata ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (payload as Record<string, unknown>)[k] ?? meta[k];
  const orgId = pick('org_id');
  const role = pick('role');
  const locationIds = pick('location_ids') ?? [];
  if (typeof payload.sub !== 'string' || typeof orgId !== 'string') {
    throw new HttpError(401, 'invalid_token', 'Token is missing sub or org_id');
  }
  if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
    throw new HttpError(401, 'invalid_token', 'Token has no valid role');
  }
  if (!Array.isArray(locationIds) || !locationIds.every((l) => typeof l === 'string')) {
    throw new HttpError(401, 'invalid_token', 'location_ids must be a list');
  }
  return { userId: payload.sub, orgId, role: role as Role, locationIds };
}

export function createVerifier(env: Env): Verifier {
  const options = { audience: env.AUTH_AUDIENCE, ...(env.AUTH_ISSUER ? { issuer: env.AUTH_ISSUER } : {}) };
  if (env.AUTH_JWKS_URL) {
    const jwks = createRemoteJWKSet(new URL(env.AUTH_JWKS_URL));
    return async (token) => {
      const { payload } = await jwtVerify(token, jwks, options).catch(() => {
        throw new HttpError(401, 'invalid_token', 'Token could not be verified');
      });
      return readClaims(payload);
    };
  }
  const secret = new TextEncoder().encode(env.AUTH_DEV_SECRET);
  return async (token) => {
    const { payload } = await jwtVerify(token, secret, { ...options, algorithms: ['HS256'] }).catch(() => {
      throw new HttpError(401, 'invalid_token', 'Token could not be verified');
    });
    return readClaims(payload);
  };
}

/** Local development and tests only: mint a 15-minute token signed with the dev secret. */
export async function signDevToken(ctx: TenantContext, secret: string, audience = 'saas-rsa-api'): Promise<string> {
  return new SignJWT({ org_id: ctx.orgId, role: ctx.role, location_ids: ctx.locationIds })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(ctx.userId)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(secret));
}
