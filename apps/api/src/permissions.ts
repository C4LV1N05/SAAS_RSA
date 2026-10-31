/**
 * RBAC at the API edge (fast, readable 403s). The database enforces the same rules
 * again through RLS, so a bug here cannot leak data across tenants or roles.
 */
import type { Role } from '@saas-rsa/db';

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
  | 'logbook:write';

const ALL: Permission[] = [
  'schedule:read', 'schedule:write', 'schedule:publish', 'time:clock', 'time:approve',
  'compliance:read', 'compliance:override', 'payroll:run', 'tips:manage', 'logbook:read', 'logbook:write',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,
  payroll_admin: ['schedule:read', 'time:approve', 'compliance:read', 'payroll:run', 'tips:manage'],
  general_manager: [
    'schedule:read', 'schedule:write', 'schedule:publish', 'time:clock', 'time:approve',
    'compliance:read', 'compliance:override', 'tips:manage', 'logbook:read', 'logbook:write',
  ],
  shift_manager: [
    'schedule:read', 'schedule:write', 'time:clock', 'time:approve', 'compliance:read',
    'tips:manage', 'logbook:read', 'logbook:write',
  ],
  employee: ['schedule:read', 'time:clock'],
  kiosk_device: ['time:clock'],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
