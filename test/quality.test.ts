import { describe, it, expect } from 'vitest';

import { assertDocumentFreshness, assessCoin, resolveBlockTime } from '../src/data/quality.js';
import { ToolError } from '../src/errors.js';
import { COINS } from './fixtures.js';

const byId = (id: string) => {
  const c = COINS.find(x => x.coin_id === id);
  if (!c) throw new Error(`fixture ${id} missing`);
  return c;
};

describe('resolveBlockTime', () => {
  it('prefers the protocol target over the most recent observed interval', () => {
    // The mean waiting time is linear in block time, so this value sets the
    // scale of every solo mining answer. The protocol target is a stable
    // property of the chain; a single observed interval is a one-sample
    // estimate of a random variable and may be absent altogether.
    const decision = resolveBlockTime(byId('Fixture-Diverging'));
    expect(decision.seconds).toBe(0.53);
    expect(decision.source).toBe('protocol_target');
  });

  it('reports the observed value and the size of the disagreement', () => {
    const decision = resolveBlockTime(byId('Fixture-Diverging'));
    expect(decision.observed_seconds).toBe(60);
    expect(decision.disagreement_pct).not.toBeNull();
    expect(Math.abs(decision.disagreement_pct as number)).toBeGreaterThan(20);
    expect(decision.warning).toContain('protocol target');
  });

  it('flags a disagreement in either direction', () => {
    // Here the observation is shorter than the target rather than longer; the
    // warning does not depend on the sign of the deviation.
    const decision = resolveBlockTime(byId('EthereumPoW'));
    expect(decision.seconds).toBe(13);
    expect(decision.warning).toBeTruthy();
  });

  it('stays quiet when target and observation agree', () => {
    const decision = resolveBlockTime(byId('Bitcoin'));
    expect(decision.seconds).toBe(600);
    expect(decision.warning).toBeNull();
  });

  it('refuses rather than substituting a default block time', () => {
    // Block times across the corpus span a second to ten minutes, so no single
    // default is defensible: with neither a target nor an observation there is
    // nothing to compute a waiting time from.
    const broken = { ...byId('Kaspa'), block_time_target: 0, block_time: null };
    expect(() => resolveBlockTime(broken)).toThrow(ToolError);
  });
});

describe('assessCoin', () => {
  it('refuses a coin whose collectors are unavailable', () => {
    // An unavailable collector leaves difficulty and network rate at zero,
    // which are valid-looking numbers that would flow into every downstream
    // formula, so the assessment refuses instead of passing them on.
    expect(() => assessCoin(byId('Fixture-Unavailable'))).toThrow(ToolError);
    try {
      assessCoin(byId('Fixture-Unavailable'));
    } catch (err) {
      expect((err as ToolError).code).toBe('data_unavailable');
    }
  });

  it('refuses to compute mining numbers without a positive network rate', () => {
    const noRate = { ...byId('Bitcoin'), network_hashrate: 0 };
    expect(() => assessCoin(noRate, { requireNumbers: true })).toThrow(ToolError);
  });

  it('warns when collector nodes disagree', () => {
    const { warnings, confidence } = assessCoin(byId('Fixture-Conflicted'));
    expect(confidence.status).toBe('conflict');
    expect(warnings.join(' ')).toContain('disagree');
  });

  it('warns when the block reward is not live-derived', () => {
    // A static fallback reward is a configured constant rather than a value
    // read from the chain, so it can lag a halving or a schedule change; the
    // provenance travels with the answer.
    const { warnings, confidence } = assessCoin(byId('Fixture-StaticReward'));
    expect(confidence.reward_status).toBe('static_fallback');
    expect(warnings.join(' ')).toContain('static_fallback');
  });

  it('carries integration blockers through to the warnings', () => {
    const { warnings, confidence } = assessCoin(byId('Fixture-Diverging'));
    expect(confidence.integration_blockers).toContain('baseline_deviation');
    expect(warnings.join(' ')).toContain('baseline_deviation');
  });

  it('is silent on a healthy coin', () => {
    const { warnings } = assessCoin(byId('Bitcoin'), { requireNumbers: true });
    expect(warnings).toEqual([]);
  });
});

describe('assertDocumentFreshness', () => {
  const dayAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  it('stays silent on a document recomputed today', () => {
    const warnings: string[] = [];
    assertDocumentFreshness('CoP for Bitcoin', dayAgo(0), warnings);
    expect(warnings).toEqual([]);
  });

  it('warns once the daily cadence has clearly slipped', () => {
    const warnings: string[] = [];
    assertDocumentFreshness('CoP for Bitcoin', dayAgo(4), warnings);
    expect(warnings.join(' ')).toContain('4 days ago');
  });

  it('refuses a document far past its recomputation cadence', () => {
    // Documents are recomputed daily, so an unexpectedly old computation date
    // means the economics no longer describe current conditions. Serving them
    // would succeed and look current, so the check refuses instead.
    expect(() => assertDocumentFreshness('CoP for Bitcoin', dayAgo(21), [])).toThrow(ToolError);
  });

  it('flags a document that carries no date at all', () => {
    const warnings: string[] = [];
    expect(assertDocumentFreshness('CoP for Bitcoin', null, warnings)).toBeNull();
    expect(warnings.join(' ')).toContain('cannot be verified');
  });
});
