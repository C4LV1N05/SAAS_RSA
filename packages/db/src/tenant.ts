/**
 * Every request runs inside one transaction with its tenant context set via
 * set_config(..., true) (transaction-local). RLS policies read these settings, so
 * a query that forgets a WHERE org_id = ... still cannot see another tenant's rows.
 * The settings vanish at COMMIT/ROLLBACK, so pooled connections never leak context.
 */
import { sql } from 'drizzle-orm';
import type { Database } from './client';

export const ROLES = ['owner', 'payroll_admin', 'general_manager', 'shift_manager', 'employee', 'kiosk_device'] as const;
export type Role = (typeof ROLES)[number];

export interface TenantContext {
  orgId: string;
  userId: string;
  role: Role;
  locationIds: readonly string[];
}

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function applyTenantContext(tx: Tx, ctx: TenantContext): Promise<void> {
  for (const id of [ctx.orgId, ctx.userId, ...ctx.locationIds]) {
    if (!UUID.test(id)) throw new Error(`Invalid tenant context id: ${id}`);
  }
  if (!ROLES.includes(ctx.role)) throw new Error(`Invalid role: ${ctx.role}`);
  await tx.execute(sql`
    select set_config('app.org_id', ${ctx.orgId}, true),
           set_config('app.user_id', ${ctx.userId}, true),
           set_config('app.role', ${ctx.role}, true),
           set_config('app.location_ids', ${ctx.locationIds.join(',')}, true)
  `);
}

export function withTenant<T>(db: Database, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await applyTenantContext(tx, ctx);
    return fn(tx);
  });
}
