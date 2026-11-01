/**
 * Staff sign-in. With Auth0 configured (VITE_AUTH0_*), staff log in through
 * Auth0 and the access token carries their organisation, role and locations.
 * Without it (local development), a development token can be pasted instead.
 */
import { createAuth0Client, type Auth0Client } from '@auth0/auth0-spa-js';

const env = import.meta.env;
const AUTH0_DOMAIN = env.VITE_AUTH0_DOMAIN as string | undefined;
const AUTH0_CLIENT_ID = env.VITE_AUTH0_CLIENT_ID as string | undefined;
const AUTH0_AUDIENCE = (env.VITE_AUTH0_AUDIENCE as string | undefined) ?? 'saas-rsa-api';
export const CLAIM_NS = (env.VITE_AUTH0_CLAIM_NAMESPACE as string | undefined) ?? 'https://saas-rsa.app/';

export const usesAuth0 = Boolean(AUTH0_DOMAIN && AUTH0_CLIENT_ID);
const DEV_KEY = 'staff:dev-token';

let client: Promise<Auth0Client> | null = null;
function auth0(): Promise<Auth0Client> {
  client ??= createAuth0Client({
    domain: AUTH0_DOMAIN!,
    clientId: AUTH0_CLIENT_ID!,
    authorizationParams: { audience: AUTH0_AUDIENCE, redirect_uri: `${window.location.origin}/staff` },
    cacheLocation: 'localstorage',
    useRefreshTokens: true,
  });
  return client;
}

export interface StaffClaims {
  userId: string;
  orgId: string;
  role: string;
  locationIds: string[];
  expiresAt: number;
}

export function decodeClaims(token: string): StaffClaims | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    const pick = (k: string) => json[`${CLAIM_NS}${k}`] ?? json[k];
    const orgId = pick('org_id');
    const role = pick('role');
    if (typeof orgId !== 'string' || typeof role !== 'string') return null;
    return {
      userId: String(pick('user_id') ?? json.sub ?? ''),
      orgId,
      role,
      locationIds: Array.isArray(pick('location_ids')) ? (pick('location_ids') as string[]) : [],
      expiresAt: typeof json.exp === 'number' ? json.exp * 1000 : 0,
    };
  } catch {
    return null;
  }
}

function readDev(): string | null {
  try {
    return localStorage.getItem(DEV_KEY);
  } catch {
    return null;
  }
}

/** Current token, or null when signed out (or expired). */
export async function getStaffToken(): Promise<string | null> {
  if (usesAuth0) {
    const c = await auth0();
    if (window.location.search.includes('code=') && window.location.search.includes('state=')) {
      await c.handleRedirectCallback();
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (!(await c.isAuthenticated())) return null;
    return (await c.getTokenSilently()) ?? null;
  }
  const token = readDev();
  const claims = token ? decodeClaims(token) : null;
  return claims && claims.expiresAt > Date.now() ? token : null;
}

export async function signIn(devToken?: string): Promise<void> {
  if (usesAuth0) {
    await (await auth0()).loginWithRedirect({ appState: { returnTo: window.location.pathname } });
    return;
  }
  if (!devToken || !decodeClaims(devToken)) throw new Error('That token is not valid');
  try {
    localStorage.setItem(DEV_KEY, devToken);
  } catch {
    throw new Error('This browser blocks storage; allow site data to sign in');
  }
}

export async function signOut(): Promise<void> {
  if (usesAuth0) {
    await (await auth0()).logout({ logoutParams: { returnTo: `${window.location.origin}/staff` } });
    return;
  }
  try {
    localStorage.removeItem(DEV_KEY);
  } catch {
    // nothing stored
  }
}

const LOCATION_KEY = 'staff:location';
export function chosenLocation(claims: StaffClaims): string | null {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LOCATION_KEY);
  } catch {
    // ignore
  }
  if (stored && (claims.locationIds.length === 0 || claims.locationIds.includes(stored))) return stored;
  return claims.locationIds[0] ?? null;
}
export function chooseLocation(id: string): void {
  try {
    localStorage.setItem(LOCATION_KEY, id);
  } catch {
    // ignore
  }
}
