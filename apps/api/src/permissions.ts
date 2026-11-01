/**
 * RBAC at the API edge (fast, readable 403s). The database enforces the same rules
 * again through RLS, so a bug here cannot leak data across tenants or roles.
 */
import type { ContextRole, Role } from '@saas-rsa/db';

export type Permission =
  | 'schedule:read'
  | 'schedule:write'
  | 'schedule:publish'
  | 'time:clock'
  | 'time:approve'
  | 'compliance:read'
  | 'compliance:override'
  | 'payroll:run'
  | 'tips:manage'
  | 'logbook:read'
  | 'logbook:write'
  // Serve: waiters, chefs and bar staff run service; managers set it up.
  | 'service:operate'
  | 'service:void'
  | 'service:manage'
  | 'inventory:manage'
  | 'till:configure';

const ALL: Permission[] = [
  'schedule:read', 'schedule:write', 'schedule:publish', 'time:clock', 'time:approve',
  'compliance:read', 'compliance:override', 'payroll:run', 'tips:manage', 'logbook:read', 'logbook:write',
  'service:operate', 'service:void', 'service:manage', 'inventory:manage', 'till:configure',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  payroll_admin: ['schedule:read', 'time:approve', 'compliance:read', 'payroll:run', 'tips:manage'],
  general_manager: [
    'schedule:read', 'schedule:write', 'schedule:publish', 'time:clock', 'time:approve',
    'compliance:read', 'compliance:override', 'tips:manage', 'logbook:read', 'logbook:write',
    'service:operate', 'service:void', 'service:manage', 'inventory:manage',
  ],
  shift_manager: [
    'schedule:read', 'schedule:write', 'time:clock', 'time:approve', 'compliance:read',
    'tips:manage', 'logbook:read', 'logbook:write', 'service:operate', 'service:void',
  ],
  employee: ['schedule:read', 'time:clock', 'service:operate'],
  kiosk_device: ['time:clock'],
};

/** Guests never hold staff permissions; their routes check the guest session instead. */
export function can(role: ContextRole, permission: Permission): boolean {
  return role !== 'guest' && ROLE_PERMISSIONS[role].includes(permission);
}
