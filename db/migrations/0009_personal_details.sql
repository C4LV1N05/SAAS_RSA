-- 0009_personal_details.sql
-- ID, tax and bank numbers are encrypted by the API (AES-256-GCM, apps/api/src/crypto.ts)
-- into the existing *_enc bytea columns. The database never sees the plain numbers.
-- The hint columns hold only the last digits, so screens can show "••••0083"
-- without decrypting anything.
alter table employees
  add column id_number_hint     text check (id_number_hint ~ '^\d{3,4}$'),
  add column tax_number_hint    text check (tax_number_hint ~ '^\d{3,4}$'),
  add column bank_account_hint  text check (bank_account_hint ~ '^\d{3,4}$'),
  add column bank_name          text,
  add column bank_branch_code   text check (bank_branch_code ~ '^\d{6}$'),
  add column bank_account_type  text check (bank_account_type in ('cheque', 'savings', 'transmission')),
  add column bank_account_holder text,
  add column personal_updated_at timestamptz;

-- Who may change these: the employees_update policy (0005) already limits updates
-- to owners, payroll admins and general managers; the API narrows personal
-- details further to owners and payroll admins (payroll:run).
