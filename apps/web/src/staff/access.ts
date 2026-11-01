/**
 * Which staff screens each role sees. This mirrors the API's permissions
 * (apps/api/src/permissions.ts) so people only see screens that will work for
 * them; the API and the database still enforce the rules.
 */
export type Screen = 'floor' | 'kitchen' | 'bar' | 'menu' | 'schedule' | 'timesheets' | 'tips' | 'logbook' | 'payroll' | 'me';

const MANAGERS = ['owner', 'general_manager', 'shift_manager'];

const ACCESS: Record<Screen, readonly string[]> = {
  floor: [...MANAGERS, 'employee'],
  kitchen: [...MANAGERS, 'employee'],
  bar: [...MANAGERS, 'employee'],
  menu: ['owner', 'general_manager'],
  schedule: MANAGERS,
  timesheets: [...MANAGERS, 'payroll_admin'],
  tips: [...MANAGERS, 'payroll_admin'],
  logbook: MANAGERS,
  payroll: ['owner', 'payroll_admin'],
  me: [...MANAGERS, 'employee'],
};

export const canSee = (role: string, screen: Screen): boolean => ACCESS[screen].includes(role);

/** Managers can publish and override; shift managers schedule but cannot publish. */
export const canPublish = (role: string) => role === 'owner' || role === 'general_manager';
export const canOverride = canPublish;

/** Where /staff lands: the first screen the role can use. */
export function homeScreen(role: string): string {
  if (role === 'payroll_admin') return 'timesheets';
  if (role === 'employee') return 'me';
  return 'floor';
}
