/**
 * Called by the Auth0 Post-Login Action, never by browsers or apps.
 * Maps an Auth0 login to our user and membership; on a first login it links the
 * invited user record by verified phone (SMS passwordless) or verified email.
 * Protected by a shared secret (AUTH_ACTION_SECRET), compared in constant time.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@saas-rsa/db';
import { HttpError } from '../errors';

export const INTERNAL_AUTH_ROUTE = '/internal/auth/claims';

const ClaimsRequest = z.object({
  sub: z.string().min(1).max(255),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/).nullable().default(null),
  phoneVerified: z.boolean().default(false),
  email: z.string().email().nullable().default(null),
  emailVerified: z.boolean().default(false),
  orgId: z.string().uuid().nullable().default(null),
});

function secretMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface MembershipRow extends Record<string, unknown> {
  user_id: string;
  org_id: string;
  role: string;
  location_ids: string[];
}

export function registerInternalAuthRoutes(app: FastifyInstance, db: Database, secret: string | undefined) {
  app.post(INTERNAL_AUTH_ROUTE, async (request) => {
    if (!secret) throw new HttpError(404, 'not_found', 'Not found');
    if (!secretMatches(request.headers['x-internal-secret'], secret)) {
      throw new HttpError(401, 'unauthenticated', 'Invalid internal secret');
    }
    const body = ClaimsRequest.parse(request.body);
    // Only verified contact details may link an existing invite to this login.
    const phone = body.phoneVerified ? body.phone : null;
    const email = body.emailVerified ? body.email : null;

    const result = await db.execute<MembershipRow>(
      sql`select user_id, org_id, role, location_ids from app.resolve_login(${body.sub}, ${phone}, ${email}, ${body.orgId}::uuid)`,
    );
    const rows = result.rows;
    if (rows.length === 0) {
      throw new HttpError(403, 'no_membership', 'This login has no active membership');
    }
    const chosen = rows[0]!;
    return {
      userId: chosen.user_id,
      orgId: chosen.org_id,
      role: chosen.role,
      locationIds: chosen.location_ids,
      // Lets the app offer an organisation switcher (log in again with ?org=<id>).
      organisations: rows.map((r) => ({ orgId: r.org_id, role: r.role })),
    };
  });
}
