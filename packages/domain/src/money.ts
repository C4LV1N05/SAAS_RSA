/**
 * Money is always an integer number of cents. Never floats.
 * Review fix #8: payroll must reconcile to the cent with SARS.
 */
export type Cents = number;

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be an integer number of cents, got ${value}`);
  }
  return value;
}

/** Rand to cents, e.g. rands(30.23) === 3023. Use only for literals and config. */
export function rands(value: number): Cents {
  return Math.round(value * 100);
}

/** Round half away from zero (SARS and payroll convention). */
export function roundHalfUp(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** amount x basisPoints / 10_000, rounded to the cent. 100 bp = 1%. */
export function applyBasisPoints(amount: Cents, basisPoints: number): Cents {
  return roundHalfUp((amount * basisPoints) / 10_000);
}

/** Pay for a number of minutes at an hourly rate and multiplier, rounded to the cent. */
export function payForMinutes(minutes: number, hourlyRate: Cents, multiplier = 1): Cents {
  return roundHalfUp((minutes * hourlyRate * multiplier) / 60);
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((total, v) => total + v, 0);
}

/** "R 1 234.56" style formatting for payslips and messages. */
export function formatRand(amount: Cents): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cents = (abs % 100).toString().padStart(2, '0');
  return `${sign}R ${whole}.${cents}`;
}

/**
 * Split a total into integer parts proportional to weights, using the
 * largest-remainder method so the parts always sum exactly to the total.
 * Ties are broken by input order, so results are deterministic.
 */
export function allocateByWeights(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total, 'total');
  if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
    throw new RangeError('weights must be finite and non-negative');
  }
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  if (weightSum === 0) return weights.map(() => 0);

  const exact = weights.map((w) => (total * w) / weightSum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}
