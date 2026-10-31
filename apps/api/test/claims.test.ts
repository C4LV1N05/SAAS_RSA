import { describe, expect, it } from 'vitest';
import { readClaims } from '../src/auth';
import { HttpError } from '../src/errors';

const user = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
const org = '9b1d7c2a-1e4f-4a6b-8c3d-2f5e6a7b8c9d';
const loc = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

describe('Auth0 claims', () => {
  it('reads namespaced custom claims from an Auth0 access token', () => {
    const payload = {
      sub: 'sms|65f0c1d2e3',
      'https://saas-rsa.app/user_id': user,
      'https://saas-rsa.app/org_id': org,
      'https://saas-rsa.app/role': 'shift_manager',
      'https://saas-rsa.app/location_ids': [loc],
    };
    expect(readClaims(payload)).toEqual({ userId: user, orgId: org, role: 'shift_manager', locationIds: [loc] });
  });

  it('rejects an Auth0 subject used as the user id', () => {
    expect(() => readClaims({ sub: 'auth0|abc', org_id: org, role: 'owner' })).toThrow(HttpError);
  });

  it('rejects unknown roles', () => {
    expect(() => readClaims({ user_id: user, org_id: org, role: 'superuser' })).toThrow(/role/);
  });
});
