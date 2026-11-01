/**
 * Field-level encryption for ID, tax and bank numbers (POPIA: special care for
 * identifiers and financial details). AES-256-GCM, with:
 *
 * - a key id in every ciphertext, so keys can be rotated: new writes use the
 *   first key in FIELD_ENCRYPTION_KEYS, older rows still decrypt with the rest;
 * - additional authenticated data binding each value to its organisation, row
 *   and field, so a ciphertext copied into another row or column fails to decrypt.
 *
 * Layout: 0x01 | key id length (1 byte) | key id | IV (12) | tag (16) | ciphertext
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;

export class FieldCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly activeId: string;

  constructor(keys: Array<{ id: string; key: Buffer }>) {
    if (keys.length === 0) throw new Error('At least one field encryption key is required');
    for (const k of keys) {
      if (k.key.length !== 32) throw new Error(`Field encryption key "${k.id}" must be 32 bytes`);
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(k.id)) throw new Error(`Invalid key id "${k.id}"`);
    }
    this.keys = new Map(keys.map((k) => [k.id, k.key]));
    this.activeId = keys[0]!.id;
  }

  encrypt(plaintext: string, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeId)!, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const id = Buffer.from(this.activeId, 'utf8');
    return Buffer.concat([Buffer.from([VERSION, id.length]), id, iv, cipher.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad: string): string {
    if (blob[0] !== VERSION) throw new Error('Unknown ciphertext version');
    const idLen = blob[1]!;
    const id = blob.subarray(2, 2 + idLen).toString('utf8');
    const key = this.keys.get(id);
    if (!key) throw new Error(`Field encryption key "${id}" is not configured`);
    const at = 2 + idLen;
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(at, at + 12));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(blob.subarray(at + 12, at + 28));
    return Buffer.concat([decipher.update(blob.subarray(at + 28)), decipher.final()]).toString('utf8');
  }

  /** Which key encrypted a value; used to find rows to re-encrypt after a rotation. */
  static keyIdOf(blob: Buffer): string {
    return blob.subarray(2, 2 + blob[1]!).toString('utf8');
  }
}

/** The AAD for an employee field: ties a ciphertext to exactly one place. */
export const employeeAad = (orgId: string, employeeId: string, field: 'id_number' | 'tax_number' | 'bank_account') =>
  `${orgId}:employees:${employeeId}:${field}`;

/**
 * FIELD_ENCRYPTION_KEYS="2026a:<base64 32 bytes>,2025a:<base64>" (first one encrypts).
 * Without it, development and tests derive a stable key from the dev auth secret;
 * production refuses to start (checked in env.ts).
 */
export function createFieldCipher(env: { FIELD_ENCRYPTION_KEYS?: string | undefined; AUTH_DEV_SECRET?: string | undefined }): FieldCipher {
  if (env.FIELD_ENCRYPTION_KEYS) {
    return new FieldCipher(
      env.FIELD_ENCRYPTION_KEYS.split(',').map((pair) => {
        const [id, b64] = pair.trim().split(':');
        if (!id || !b64) throw new Error('FIELD_ENCRYPTION_KEYS entries look like id:base64key');
        return { id, key: Buffer.from(b64, 'base64') };
      }),
    );
  }
  if (!env.AUTH_DEV_SECRET) throw new Error('Set FIELD_ENCRYPTION_KEYS');
  const key = Buffer.from(hkdfSync('sha256', env.AUTH_DEV_SECRET, 'saas-rsa', 'field-encryption-dev', 32));
  return new FieldCipher([{ id: 'dev', key }]);
}
