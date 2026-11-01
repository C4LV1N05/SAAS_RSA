/**
 * The guest's table session lives in sessionStorage (this browser tab only), so
 * it ends when they close the tab. Storage can be unavailable (private mode,
 * blocked site data), so every access is guarded and falls back to memory.
 */
export interface StoredSession {
  tagToken: string;
  sessionToken: string;
  tabId: string;
  table: string;
  expiresAt: string;
}

const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
}

export function loadSession(tagToken: string): StoredSession | null {
  const raw = read(`table:${tagToken}`);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StoredSession;
    return new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession): void {
  write(`table:${s.tagToken}`, JSON.stringify(s));
  write('table:last', s.tagToken);
}

export function forgetSession(tagToken: string): void {
  write(`table:${tagToken}`, null);
}

export const lastTable = () => read('table:last');

/** A scanned waiter tip code, applied when the guest pays. */
export const saveTipCode = (code: string) => write('tip:code', code);
export const loadTipCode = () => read('tip:code');
export const clearTipCode = () => write('tip:code', null);
