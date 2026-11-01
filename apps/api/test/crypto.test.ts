import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFieldCipher, employeeAad, FieldCipher } from '../src/crypto';
import { loadEnv } from '../src/env';

const key = () => randomBytes(32);

describe('field encryption', () => {
  const aad = employeeAad('org-1', 'emp-1', 'bank_account');

  it('round-trips, and never produces the same ciphertext twice', () => {
    const c = new FieldCipher([{ id: 'k1', key: key() }]);
    const a = c.encrypt('1234567890', aad);
    const b = c.encrypt('1234567890', aad);
    expect(a.equals(b)).toBe(false);
    expect(a.toString('latin1')).not.toContain('1234567890');
    expect(c.decrypt(a, aad)).toBe('1234567890');
  });

  it('refuses a ciphertext moved to another employee or field', () => {
    const c = new FieldCipher([{ id: 'k1', key: key() }]);
    const blob = c.encrypt('1234567890', aad);
    expect(() => c.decrypt(blob, employeeAad('org-1', 'emp-2', 'bank_account'))).toThrow();
    expect(() => c.decrypt(blob, employeeAad('org-1', 'emp-1', 'tax_number'))).toThrow();
  });

  it('detects tampering', () => {
    const c = new FieldCipher([{ id: 'k1', key: key() }]);
    const blob = c.encrypt('8001015009087', aad);
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect(() => c.decrypt(blob, aad)).toThrow();
  });

  it('rotates keys: new writes use the first key, old values still decrypt', () => {
    const oldKey = { id: '2025a', key: key() };
    const old = new FieldCipher([oldKey]).encrypt('0123456782', aad);
    const rotated = new FieldCipher([{ id: '2026a', key: key() }, oldKey]);
    expect(rotated.decrypt(old, aad)).toBe('0123456782');
    expect(FieldCipher.keyIdOf(rotated.encrypt('x', aad))).toBe('2026a');
    expect(() => new FieldCipher([{ id: '2026a', key: key() }]).decrypt(old, aad)).toThrow(/not configured/);
  });

  it('reads keys from the environment and requires them in production', () => {
    const b64 = key().toString('base64');
    expect(FieldCipher.keyIdOf(createFieldCipher({ FIELD_ENCRYPTION_KEYS: `2026a:${b64}` }).encrypt('x', aad))).toBe('2026a');
    expect(() => new FieldCipher([{ id: 'short', key: randomBytes(16) }])).toThrow(/32 bytes/);
    expect(() =>
      loadEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x@y/z', AUTH_JWKS_URL: 'https://t.auth0.com/.well-known/jwks.json', AUTH_ISSUER: 'https://t.auth0.com/' }),
    ).toThrow(/FIELD_ENCRYPTION_KEYS/);
  });
});
