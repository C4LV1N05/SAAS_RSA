/**
 * Checks for South African identity, tax and bank numbers, run before they are
 * encrypted and stored. Pure functions, no I/O.
 */

/** Luhn (modulus 10) check, used by SA ID numbers. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export type IdCheck =
  | { valid: true; dateOfBirth: string; citizen: boolean }
  | { valid: false; reason: string };

/**
 * A 13-digit SA ID number: YYMMDD SSSS C A Z. The date must be real, C is 0
 * (citizen) or 1 (permanent resident), and Z is a Luhn check digit. The century
 * is the latest one that does not put the birth date in the future.
 */
export function checkSaIdNumber(input: string, today: string = new Date().toISOString().slice(0, 10)): IdCheck {
  const id = input.replace(/\s/g, '');
  if (!/^\d{13}$/.test(id)) return { valid: false, reason: 'An SA ID number has 13 digits' };
  const yy = Number(id.slice(0, 2));
  const mm = id.slice(2, 4);
  const dd = id.slice(4, 6);
  const thisYear = Number(today.slice(0, 4));
  let year = 2000 + yy;
  if (`${year}-${mm}-${dd}` > today) year -= 100;
  const dob = `${year}-${mm}-${dd}`;
  const date = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dob) {
    return { valid: false, reason: 'The first six digits are not a real date of birth' };
  }
  if (thisYear - year > 120) return { valid: false, reason: 'The date of birth is not plausible' };
  const c = id[10];
  if (c !== '0' && c !== '1') return { valid: false, reason: 'The 11th digit must be 0 (citizen) or 1 (permanent resident)' };
  if (!luhnValid(id)) return { valid: false, reason: 'The check digit does not match; check for a typo' };
  return { valid: true, dateOfBirth: dob, citizen: c === '0' };
}

export type TaxCheck = { valid: true; warning?: string } | { valid: false; reason: string };

/**
 * A SARS income tax reference number: 10 digits starting with 0, 1, 2, 3 or 9.
 * SARS does not publish its check-digit rule as a standard, so a failed Luhn
 * check is only a warning, never a refusal.
 */
export function checkTaxNumber(input: string): TaxCheck {
  const n = input.replace(/\s/g, '');
  if (!/^\d{10}$/.test(n)) return { valid: false, reason: 'A tax reference number has 10 digits' };
  if (!'01239'.includes(n[0]!)) return { valid: false, reason: 'Individual tax numbers start with 0, 1, 2, 3 or 9' };
  return luhnValid(n) ? { valid: true } : { valid: true, warning: 'Double-check this number against the employee\'s SARS letter' };
}

/** Universal branch codes of the main SA banks, used to fill the branch code in. */
export const UNIVERSAL_BRANCH_CODES: Record<string, string> = {
  ABSA: '632005',
  'African Bank': '430000',
  'Bidvest Bank': '462005',
  Capitec: '470010',
  'Discovery Bank': '679000',
  FNB: '250655',
  Investec: '580105',
  Nedbank: '198765',
  'Standard Bank': '051001',
  TymeBank: '678910',
};

export const BANK_ACCOUNT_TYPES = ['cheque', 'savings', 'transmission'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

export interface BankDetails {
  holder: string;
  bankName: string;
  branchCode: string;
  accountNumber: string;
  accountType: BankAccountType;
}

export function checkBankDetails(b: BankDetails): { valid: true } | { valid: false; reason: string } {
  if (b.holder.trim().length < 2) return { valid: false, reason: 'Enter the account holder\'s name' };
  if (!/^\d{6}$/.test(b.branchCode)) return { valid: false, reason: 'A branch code has 6 digits' };
  if (!/^\d{6,16}$/.test(b.accountNumber.replace(/\s/g, ''))) return { valid: false, reason: 'An account number has 6 to 16 digits' };
  return { valid: true };
}

/** "••••••0083": what screens show instead of the full number. */
export function maskTail(value: string, visible = 4): string {
  const clean = value.replace(/\s/g, '');
  return `${'•'.repeat(Math.max(0, clean.length - visible))}${clean.slice(-visible)}`;
}
