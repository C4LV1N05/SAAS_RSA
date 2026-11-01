/** Shared types and loaders for the Team screens. */
import { api } from '../lib/api';

export interface TeamMember {
  id: string;
  firstName: string;
  lastName: string;
  jobRoleId: string | null;
  jobRole: string | null;
  tipGroup: string | null;
  hasLogin: boolean;
  hasDateOfBirth: boolean;
  daysPerWeek: number;
  overtimeAgreement: boolean;
  rate: { type: 'hourly' | 'monthly'; cents: number } | null;
}

export interface Team {
  employees: TeamMember[];
  jobRoles: Array<{ id: string; name: string; tipGroup: string }>;
}

export const loadTeam = (token: string, locationId: string) => api<Team>(`/v1/team?locationId=${locationId}`, { token });

export const fullName = (m: Pick<TeamMember, 'firstName' | 'lastName'>) => `${m.firstName} ${m.lastName}`;

/** Look up a name by employee id, for lists that only carry ids. */
export function nameLookup(team: Team | null): (id: string | null | undefined) => string {
  return (id) => {
    if (!id) return 'Open shift';
    const m = team?.employees.find((e) => e.id === id);
    return m ? fullName(m) : 'Someone at another location';
  };
}
