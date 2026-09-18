import { describe, it, expect } from 'vitest';

import {
  PROBABILITY_CEILING,
  calculateExponentialQuantile,
  calculatePoissonProbability,
  familyFromRateUnit,
  formatDuration,
  formatHashrate,
  formatRate,
  parseHashrate,
  parseRate,
} from '../src/math/poisson.js';
import { ToolError } from '../src/errors.js';

describe('rate parsing', () => {
  it('converts every hash-family unit', () => {
    expect(parseHashrate(100, 'H/s')).toBe(100);
    expect(parseHashrate(50, 'KH/s')).toBe(50_000);
    expect(parseHashrate(25, 'MH/s')).toBe(25_000_000);
    expect(parseHashrate(10, 'GH/s')).toBe(10_000_000_000);
    expect(parseHashrate(120, 'TH/s')).toBe(120_000_000_000_000);
    expect(parseHashrate(1.5, 'PH/s')).toBe(1.5e15);
    expect(parseHashrate(0.8, 'EH/s')).toBe(8e17);
  });

  it('accepts case, whitespace and an implied /s in the unit', () => {
    expect(parseRate(1, 'th/s').canonical).toBe('TH/s');
    expect(parseRate(1, 'TH').canonical).toBe('TH/s');
    expect(parseRate(1, ' TH/s ').canonical).toBe('TH/s');
  });

  it('rejects an unrecognised unit rather than defaulting to H/s', () => {
    // Units differ by factors of 10^3 up to 10^18, so a unit that cannot be
    // identified has no safe interpretation: guessing H/s would scale the
    // answer by many orders of magnitude while still looking well-formed.
    for (const unit of ['banana', 'TH/sec', 'terahash', 'T/s', '']) {
      expect(() => parseRate(100, unit)).toThrow(ToolError);
    }
  });

  it('rejects non-finite and non-positive values', () => {
    for (const value of [NaN, Infinity, -1, 0]) {
      expect(() => parseRate(value, 'TH/s')).toThrow(ToolError);
    }
  });

  it('carries the unit family so a rig can be checked against the network', () => {
    expect(parseRate(100, 'TH/s').family).toBe('hash');
    expect(parseRate(100, 'gps').family).toBe('graph');
    expect(parseRate(100, 'proofs/s').family).toBe('proof');
    expect(parseRate(85, 'Sol/s').family).toBe('hash');
  });

  it('maps the oracle rate_unit onto a family', () => {
    expect(familyFromRateUnit('hashes_per_second')).toBe('hash');
    expect(familyFromRateUnit('graphs_per_second')).toBe('graph');
    expect(familyFromRateUnit('proofs_per_second')).toBe('proof');
  });
});

describe('rate formatting', () => {
  it('formats the hash family with SI prefixes', () => {
    expect(formatHashrate(500)).toBe('500.00 H/s');
    expect(formatHashrate(150_000)).toBe('150.00 KH/s');
    expect(formatHashrate(45_000_000)).toBe('45.00 MH/s');
    expect(formatHashrate(2_500_000_000)).toBe('2.50 GH/s');
    expect(formatHashrate(1e18)).toBe('1.00 EH/s');
  });

  it('labels non-hash networks in their own unit', () => {
    // Not every network measures work in hashes: zero-knowledge chains count
    // proofs and the Cuckoo family counts graphs, so the SI prefix is applied
    // to the family's own unit rather than to H/s.
    expect(formatRate(646_820_575_977, 'proof')).toBe('646.82 Gproofs/s');
    expect(formatRate(2772, 'graph')).toBe('2.77 Kgps');
  });

  it('returns null rather than rendering a missing measurement as zero', () => {
    expect(formatRate(0, 'hash')).toBeNull();
    expect(formatRate(NaN, 'hash')).toBeNull();
  });
});

describe('durations', () => {
  it('reads naturally across scales', () => {
    expect(formatDuration(45)).toBe('45 seconds');
    expect(formatDuration(180)).toBe('3 minutes');
    expect(formatDuration(7200)).toBe('2 hours');
    expect(formatDuration(172800)).toBe('2 days');
    expect(formatDuration(86400 * 400)).toBe('1.1 years');
  });
});

describe('Poisson probabilities', () => {
  it('computes P(X >= 1) as a percentage', () => {
    expect(calculatePoissonProbability(86400, 86400)).toBeCloseTo(63.21, 1);
    expect(calculatePoissonProbability(5 * 86400, 86400)).toBeCloseTo(99.33, 1);
    expect(calculatePoissonProbability(0, 86400)).toBe(0);
  });

  it('saturates to the ceiling on both degenerate paths', () => {
    // The function's contract is a percentage, so both ways of reaching
    // effective certainty return the same capped percentage: a non-positive or
    // non-finite mean time-to-block, and a mean small enough relative to the
    // window that the exponential underflows.
    expect(calculatePoissonProbability(86400, 0)).toBe(PROBABILITY_CEILING);
    expect(calculatePoissonProbability(86400, -5)).toBe(PROBABILITY_CEILING);
    expect(calculatePoissonProbability(86400, NaN)).toBe(PROBABILITY_CEILING);
    expect(calculatePoissonProbability(1e9, 1)).toBe(PROBABILITY_CEILING);
  });

  it('never claims certainty', () => {
    expect(PROBABILITY_CEILING).toBeLessThan(100);
  });
});

describe('exponential quantiles', () => {
  it('computes waiting-time percentiles', () => {
    expect(calculateExponentialQuantile(0.5, 1000)).toBeCloseTo(693.15, 1);
    expect(calculateExponentialQuantile(0.05, 1000)).toBeCloseTo(51.29, 1);
    expect(calculateExponentialQuantile(0.95, 1000)).toBeCloseTo(2995.73, 1);
  });

  it('degrades safely on a non-positive mean', () => {
    expect(calculateExponentialQuantile(0.5, 0)).toBe(0);
  });
});
