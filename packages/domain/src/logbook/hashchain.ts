/**
 * Manager Log Book hash chain. Each entry stores the hash of the entry before it
 * (per organisation), so editing or deleting any past row breaks every later hash.
 * This is what makes the log book tamper-evident for CCMA proceedings; RBAC alone
 * is access control, not integrity.
 */
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface LogHashInput {
  orgId: string;
  locationId: string;
  entryGroupId: string;
  revision: number;
  seq: number;
  authorUserId: string;
  category: string;
  body: string;
  attachments: unknown;
  shiftId: string | null;
  employeeId: string | null;
  /** ISO 8601 timestamp stored with the row. */
  createdAt: string;
}

/** JSON with object keys sorted recursively, so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function computeLogHash(prevHash: string, entry: LogHashInput): string {
  return createHash('sha256').update(`${prevHash}\n${canonicalJson(entry)}`).digest('hex');
}

export interface ChainedEntry extends LogHashInput {
  prevHash: string;
  hash: string;
}

export type ChainVerification = { valid: true; entries: number } | { valid: false; brokenAtSeq: number; reason: string };

export function verifyChain(entries: readonly ChainedEntry[]): ChainVerification {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  let expectedPrev = GENESIS_HASH;
  for (const [i, e] of sorted.entries()) {
    if (e.seq !== i + 1) return { valid: false, brokenAtSeq: e.seq, reason: `sequence gap: expected ${i + 1}` };
    if (e.prevHash !== expectedPrev) return { valid: false, brokenAtSeq: e.seq, reason: 'prev_hash does not match the previous entry' };
    const { prevHash: _p, hash: _h, ...input } = e;
    if (computeLogHash(e.prevHash, input) !== e.hash) {
      return { valid: false, brokenAtSeq: e.seq, reason: 'entry content does not match its hash' };
    }
    expectedPrev = e.hash;
  }
  return { valid: true, entries: sorted.length };
}
