import { describe, expect, it } from 'vitest';
import { checkBankDetails, checkSaIdNumber, checkTaxNumber, luhnValid, maskTail } from '../src/identity';

describe('SA ID numbers', () => {
  it('accepts a valid number and reads the date of birth, picking the right century', () => {
    expect(checkSaIdNumber('800101 5009 087', '2026-11-02')).toEqual({ valid: true, dateOfBirth: '1980-01-01', citizen: true });
    expect(checkSaIdNumber('0108190123084', '2026-11-02')).toEqual({ valid: true, dateOfBirth: '2001-08-19', citizen: true });
  });
  it('rejects wrong lengths, impossible dates, bad citizenship digits and typos', () => {
    expect(checkSaIdNumber('80010150090', '2026-11-02')).toMatchObject({ valid: false, reason: expect.stringMatching(/13 digits/) });
    expect(checkSaIdNumber('0502295123181', '2026-11-02')).toMatchObject({ valid: false, reason: expect.stringMatching(/real date/) }); // 29 Feb 2005
    expect(checkSaIdNumber('8001015009587', '2026-11-02')).toMatchObject({ valid: false, reason: expect.stringMatching(/11th digit/) });
    expect(checkSaIdNumber('8001015009088', '2026-11-02')).toMatchObject({ valid: false, reason: expect.stringMatching(/check digit/) });
  });
});

describe('tax and bank numbers', () => {
  it('checks the tax reference format; a failed check digit is only a warning', () => {
    expect(checkTaxNumber('0123456782')).toEqual({ valid: true });
    expect(checkTaxNumber('0123456789')).toMatchObject({ valid: true, warning: expect.any(String) });
    expect(checkTaxNumber('5123456782')).toMatchObject({ valid: false });
    expect(checkTaxNumber('12345')).toMatchObject({ valid: false });
  });
  it('checks branch codes and account numbers', () => {
    const ok = { holder: 'A Zulu', bankName: 'Capitec', branchCode: '470010', accountNumber: '1234 567 890', accountType: 'savings' as const };
    expect(checkBankDetails(ok)).toEqual({ valid: true });
    expect(checkBankDetails({ ...ok, branchCode: '4700' })).toMatchObject({ valid: false });
    expect(checkBankDetails({ ...ok, accountNumber: '12' })).toMatchObject({ valid: false });
  });
  it('masks all but the last digits', () => {
    expect(maskTail('1234567890')).toBe('••••••7890');
    expect(luhnValid('79927398713')).toBe(true);
  });
});
