/**
 * Every request runs inside one transaction with its tenant context set via
 * set_config(..., true) (transaction-local). RLS policies read these settings, so
 * a query that forgets a WHERE org_id = ... still cannot see another tenant's rows.
 * The settings vanish at COMMIT/ROLLBACK, so pooled connections never leak context.
 */
import { sql } from 'drizzle-orm';
import type { Database } from './client';

/** Staff roles: the only roles a login (membership) can carry. */
export const ROLES = ['owner', 'payroll_admin', 'general_manager', 'shift_manager', 'employee', 'kiosk_device'] as const;
export type Role = (typeof ROLES)[number];

/** Guests ordering at a table: no login, one tab, never a staff role. */
export type ContextRole = Role | 'guest';
const CONTEXT_ROLES: readonly ContextRole[] = [...ROLES, 'guest'];

export interface TenantContext {
  orgId: string;
  /** Staff: users.id. Guests: their guest session id. */
  userId: string;
  role: ContextRole;
  locationIds: readonly string[];
  /** Guests only: the tab they may see and order on. */
  tabId?: string;
}

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function applyTenantContext(tx: Tx, ctx: TenantContext): Promise<void> {
  for (const id of [ctx.orgId, ctx.userId, ...ctx.locationIds, ...(ctx.tabId ? [ctx.tabId] : [])]) {
    if (!UUID.test(id)) throw new Error(`Invalid tenant context id: ${id}`);
  }
  if (!CONTEXT_ROLES.includes(ctx.role)) throw new Error(`Invalid role: ${ctx.role}`);
  if ((ctx.role === 'guest') !== Boolean(ctx.tabId)) throw new Error('Guest context needs exactly one tab');
  await tx.execute(sql`
    select set_config('app.org_id', ${ctx.orgId}, true),
           set_config('app.user_id', ${ctx.userId}, true),
           set_config('app.role', ${ctx.role}, true),
           set_config('app.location_ids', ${ctx.locationIds.join(',')}, true),
           set_config('app.tab_id', ${ctx.tabId ?? ''}, true)
  `);
}

export function withTenant<T>(db: Database, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await applyTenantContext(tx, ctx);
    return fn(tx);
  });
}
