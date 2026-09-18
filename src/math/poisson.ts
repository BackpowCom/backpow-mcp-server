/**
 * Poisson / exponential mathematics for solo mining, and rate-unit handling.
 *
 * Two rules hold throughout:
 *
 * 1. An unrecognised rate unit throws rather than defaulting to H/s. SI
 *    prefixes span eighteen orders of magnitude, so guessing at a unit turns a
 *    typo into a plausible-looking answer that is wrong by a factor of 10^18.
 * 2. Every branch of the probability function returns a percentage in
 *    [0, PROBABILITY_CEILING], the saturating ones included, so callers never
 *    have to ask which scale a particular result is on.
 */

import { invalidArguments } from '../errors.js';

/**
 * PoW networks do not all measure work in hashes. The oracle reports a
 * `rate_unit` per coin: hashes_per_second for most, graphs_per_second for the
 * Cuckoo family (Aeternity, Grin, MWC, Tari) and proofs_per_second for Aleo.
 * Graph and proof rates are not hash rates and are not comparable to them, so
 * the family travels with the number and decides how it is labelled.
 */
export type RateFamily = 'hash' | 'graph' | 'proof';

export const DEFAULT_RATE_FAMILY: RateFamily = 'hash';

/** Maps the oracle's `rate_unit` string onto a family. */
export function familyFromRateUnit(rateUnit: string | null | undefined): RateFamily {
  switch ((rateUnit || '').trim().toLowerCase()) {
    case 'graphs_per_second':
      return 'graph';
    case 'proofs_per_second':
      return 'proof';
    case 'hashes_per_second':
    case '':
      return 'hash';
    default:
      return 'hash';
  }
}

const SI_PREFIXES: Array<{ symbol: string; factor: number }> = [
  { symbol: '', factor: 1 },
  { symbol: 'K', factor: 1e3 },
  { symbol: 'M', factor: 1e6 },
  { symbol: 'G', factor: 1e9 },
  { symbol: 'T', factor: 1e12 },
  { symbol: 'P', factor: 1e15 },
  { symbol: 'E', factor: 1e18 },
  { symbol: 'Z', factor: 1e21 },
];

const FAMILY_SUFFIX: Record<RateFamily, string> = {
  hash: 'H/s',
  graph: 'gps',
  proof: 'proofs/s',
};

interface UnitSpec {
  factor: number;
  family: RateFamily;
  canonical: string;
}

/** Build the accepted-unit lookup once. Keys are normalised (see `normaliseUnit`). */
function buildUnitTable(): Map<string, UnitSpec> {
  const table = new Map<string, UnitSpec>();

  const add = (key: string, spec: UnitSpec) => {
    table.set(normaliseUnit(key), spec);
  };

  for (const { symbol, factor } of SI_PREFIXES) {
    // Hash family: "H/s", "KH/s", … plus bare "H", "KH", … and long forms.
    const hashCanonical = `${symbol}H/s`;
    const hashSpec: UnitSpec = { factor, family: 'hash', canonical: hashCanonical };
    add(`${symbol}H/s`, hashSpec);
    add(`${symbol}H`, hashSpec);
    add(`${symbol}hash/s`, hashSpec);
    add(`${symbol}hashes/s`, hashSpec);
    add(`${symbol}hps`, hashSpec);
    // Equihash rigs are quoted in Sol/s; the oracle reports those networks in
    // hashes_per_second and treats solutions 1:1 with hashes, so Sol/s is
    // accepted into the hash family rather than rejected as an unknown unit.
    add(`${symbol}Sol/s`, hashSpec);
    add(`${symbol}Sols/s`, hashSpec);

    const graphCanonical = `${symbol}gps`;
    const graphSpec: UnitSpec = { factor, family: 'graph', canonical: graphCanonical };
    add(`${symbol}gps`, graphSpec);
    add(`${symbol}graph/s`, graphSpec);
    add(`${symbol}graphs/s`, graphSpec);

    const proofCanonical = `${symbol}proofs/s`;
    const proofSpec: UnitSpec = { factor, family: 'proof', canonical: proofCanonical };
    add(`${symbol}proofs/s`, proofSpec);
    add(`${symbol}proof/s`, proofSpec);
    add(`${symbol}prfs/s`, proofSpec);
  }

  return table;
}

function normaliseUnit(unit: string): string {
  return unit.replace(/[\s_]/g, '').toLowerCase();
}

const UNIT_TABLE = buildUnitTable();

/** Units advertised in the tool schema enum, in ascending magnitude per family. */
export const ADVERTISED_UNITS: string[] = [
  'H/s',
  'KH/s',
  'MH/s',
  'GH/s',
  'TH/s',
  'PH/s',
  'EH/s',
  'Sol/s',
  'KSol/s',
  'MSol/s',
  'GSol/s',
  'gps',
  'Kgps',
  'Mgps',
  'Ggps',
  'proofs/s',
  'Kproofs/s',
  'Mproofs/s',
  'Gproofs/s',
];

export interface ParsedRate {
  /** Value converted to base units per second. */
  perSecond: number;
  family: RateFamily;
  /** Normalised spelling of the unit, e.g. "TH/s" for an input of "th/sec". */
  canonical: string;
}

/**
 * Convert a caller-supplied rate into base units per second.
 * Throws on an unrecognised unit rather than silently assuming H/s.
 */
export function parseRate(value: number, unit: string): ParsedRate {
  if (!Number.isFinite(value) || value <= 0) {
    throw invalidArguments(
      `hashrate must be a finite positive number, received ${JSON.stringify(value)}.`
    );
  }
  if (typeof unit !== 'string' || unit.trim() === '') {
    throw invalidArguments('hashrate_unit is required.', { accepted_units: ADVERTISED_UNITS });
  }

  const spec = UNIT_TABLE.get(normaliseUnit(unit));
  if (!spec) {
    throw invalidArguments(
      `Unsupported hashrate_unit "${unit}". Accepted units: ${ADVERTISED_UNITS.join(', ')}.`,
      { accepted_units: ADVERTISED_UNITS }
    );
  }

  const perSecond = value * spec.factor;
  if (!Number.isFinite(perSecond) || perSecond <= 0) {
    throw invalidArguments(`hashrate ${value} ${unit} overflows to a non-finite value.`);
  }

  return { perSecond, family: spec.family, canonical: spec.canonical };
}

/**
 * Back-compatible numeric parse. Prefer `parseRate`, which also returns the
 * unit family so callers can detect a rig/network unit mismatch.
 */
export function parseHashrate(val: number, unit: string): number {
  return parseRate(val, unit).perSecond;
}

/** Render a rate with the SI prefix and suffix appropriate to its family. */
export function formatRate(rate: number, family: RateFamily = DEFAULT_RATE_FAMILY): string | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const suffix = FAMILY_SUFFIX[family];
  let idx = 0;
  let val = rate;
  while (val >= 1000 && idx < SI_PREFIXES.length - 1) {
    val /= 1000;
    idx++;
  }
  return `${val.toFixed(2)} ${SI_PREFIXES[idx].symbol}${suffix}`;
}

/**
 * Hash-family formatter with a non-nullable return.
 * Returns "0 H/s" for a non-positive rate; callers that need to distinguish
 * "zero" from "not measured" should use `formatRate`, which returns null.
 */
export function formatHashrate(rate: number): string {
  return formatRate(rate, 'hash') ?? '0 H/s';
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 seconds';
  const days = seconds / 86400;
  if (days >= 365.25) {
    const years = days / 365.25;
    return `${parseFloat(years.toFixed(1))} years`;
  }
  if (days >= 1) {
    return `${parseFloat(days.toFixed(1))} days`;
  }
  const hours = seconds / 3600;
  if (hours >= 1) {
    return `${parseFloat(hours.toFixed(1))} hours`;
  }
  const minutes = seconds / 60;
  if (minutes >= 1) {
    return `${parseFloat(minutes.toFixed(1))} minutes`;
  }
  const whole = Math.round(seconds);
  return `${whole} ${whole === 1 ? 'second' : 'seconds'}`;
}

/** Probabilities at or above this are reported as this value; a Poisson process never reaches 100%. */
export const PROBABILITY_CEILING = 99.9999;

export const PROBABILITY_NOTE =
  'Probabilities are the Poisson chance of finding at least one block in the window, ' +
  `assuming constant difficulty. Values are clamped at ${PROBABILITY_CEILING}% — a Poisson ` +
  'process never reaches certainty.';

/**
 * P(X >= 1) over `tSeconds` for a process with mean waiting time
 * `meanSecondsPerBlock`, expressed as a percentage in [0, PROBABILITY_CEILING].
 */
export function calculatePoissonProbability(tSeconds: number, meanSecondsPerBlock: number): number {
  if (!Number.isFinite(tSeconds) || tSeconds <= 0) return 0.0;
  // A non-positive or non-finite mean describes a block at every instant:
  // certainty, returned on the same percent scale and under the same ceiling
  // as every other saturating case.
  if (!Number.isFinite(meanSecondsPerBlock) || meanSecondsPerBlock <= 0) {
    return PROBABILITY_CEILING;
  }
  const lambda = tSeconds / meanSecondsPerBlock;
  if (lambda > 30) return PROBABILITY_CEILING;
  const prob = 1.0 - Math.exp(-lambda);
  return Math.min(PROBABILITY_CEILING, Number((prob * 100).toFixed(4)));
}

/** Waiting-time quantile of an exponential process: t_p = -T * ln(1 - p). */
export function calculateExponentialQuantile(p: number, meanSecondsPerBlock: number): number {
  if (!Number.isFinite(meanSecondsPerBlock) || meanSecondsPerBlock <= 0) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return Infinity;
  return -meanSecondsPerBlock * Math.log(1 - p);
}
