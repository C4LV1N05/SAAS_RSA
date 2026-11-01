/** Money is always integer cents. "R 1 234.50", the South African convention. */
export function rand(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${sign}R ${whole}.${(abs % 100).toString().padStart(2, '0')}`;
}

export interface TipOption {
  label: string;
  cents: number;
}

/** No tip, 10%, 12.5% and 15%, rounded to whole rand. */
export function tipOptions(billCents: number): TipOption[] {
  const pct = (p: number) => Math.round((billCents * p) / 100 / 100) * 100;
  return [
    { label: 'No tip', cents: 0 },
    { label: '10%', cents: pct(10) },
    { label: '12.5%', cents: pct(12.5) },
    { label: '15%', cents: pct(15) },
  ];
}

/** Parse "45" or "45.50" (rand) into cents; null when invalid. */
export function parseRand(input: string): number | null {
  const cleaned = input.replace(/[R\s ]/g, '').replace(',', '.');
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}
