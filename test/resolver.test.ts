import { describe, it, expect } from 'vitest';

import { CoinResolver, normalise } from '../src/data/resolver.js';
import { OracleClient } from '../src/services/oracleClient.js';
import { SiteDataClient } from '../src/services/siteDataClient.js';
import { ToolError } from '../src/errors.js';
import { COINS, fakeOracle, fakeSite } from './fixtures.js';

const resolver = new CoinResolver(
  fakeOracle() as unknown as OracleClient,
  fakeSite() as unknown as SiteDataClient
);

async function expectToolError(fn: () => Promise<unknown>): Promise<ToolError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error('expected a ToolError, but the call resolved');
}

describe('normalise', () => {
  it('folds case and drops separators so a two-word name reaches the exact-id tier', () => {
    expect(normalise('Bitcoin Cash')).toBe('bitcoincash');
    expect(normalise('ethereum classic')).toBe('ethereumclassic');
    expect(normalise('DGB-Odocrypt')).toBe('dgbodocrypt');
  });
});

describe('CoinResolver — exact matches', () => {
  it('resolves an exact canonical id regardless of case', async () => {
    expect((await resolver.resolve('Bitcoin')).id).toBe('Bitcoin');
    expect((await resolver.resolve('bitcoin')).id).toBe('Bitcoin');
  });

  it('resolves an unambiguous ticker', async () => {
    const res = await resolver.resolve('KAS');
    expect(res.id).toBe('Kaspa');
    expect(res.resolved_via).toBe('exact_ticker');
  });

  it('prefers an exact id over a prefix that would be ambiguous', async () => {
    // "bitcoin" prefixes Bitcoin, BitcoinCash and BitcoinGold; the exact id wins.
    const res = await resolver.resolve('bitcoin');
    expect(res.id).toBe('Bitcoin');
    expect(res.resolved_via).toBe('exact_id');
  });

  it('resolves a name written as separate words', async () => {
    // Canonical ids are written without separators, so normalisation is what
    // lets the spelling a caller is likely to use reach the exact-id tier.
    expect((await resolver.resolve('bitcoin cash')).id).toBe('BitcoinCash');
    expect((await resolver.resolve('ethereum classic')).id).toBe('EthereumClassic');
  });
});

describe('CoinResolver — ambiguity', () => {
  it('refuses a one-character query as too ambiguous to resolve', async () => {
    const err = await expectToolError(() => resolver.resolve('b'));
    expect(err.code).toBe('unknown_coin');
  });

  it('refuses a prefix shared by two networks', async () => {
    const err = await expectToolError(() => resolver.resolve('k'));
    expect(err.code).toBe('unknown_coin');
  });

  it('refuses a ticker shared by several chains and lists them', async () => {
    // A ticker is not a unique key: a chain with several mining algorithms
    // publishes one coin id per algorithm under the same ticker, and they have
    // different difficulties, so each tier collects every match and refuses
    // when there is more than one.
    const err = await expectToolError(() => resolver.resolve('DGB'));
    expect(err.code).toBe('ambiguous_coin');
    expect(err.data.candidates).toEqual(
      expect.arrayContaining(['DGB-Odocrypt', 'DGB-SHA', 'DGB-Scrypt'])
    );
  });

  it('refuses an ambiguous prefix and lists the candidates', async () => {
    // Several networks share a name prefix, so returning the first match would
    // mean answering about a different coin than the caller meant. The
    // candidate list lets the caller pick the one they intended.
    const err = await expectToolError(() => resolver.resolve('ethereum'));
    expect(err.code).toBe('ambiguous_coin');
    expect(err.data.candidates).toEqual(
      expect.arrayContaining(['EthereumClassic', 'EthereumPoW'])
    );
  });

  it('never resolves a path-traversal string', async () => {
    const err = await expectToolError(() => resolver.resolve('../bot_data'));
    expect(['unknown_coin', 'ambiguous_coin']).toContain(err.code);
  });

  it('offers suggestions for a near miss', async () => {
    const err = await expectToolError(() => resolver.resolve('monerro'));
    expect(err.code).toBe('unknown_coin');
    expect(err.data.did_you_mean).toContain('Monero');
  });

  it('tryResolve swallows the failure for callers where a miss is normal', async () => {
    expect(await resolver.tryResolve('definitely-not-a-coin')).toBeNull();
    expect((await resolver.tryResolve('Monero'))?.id).toBe('Monero');
  });
});

describe('CoinResolver — corpus sweep', () => {
  it('resolves every canonical id in the corpus to itself', async () => {
    for (const c of COINS) {
      const res = await resolver.resolve(c.coin_id);
      expect(res.id).toBe(c.coin_id);
    }
  });
});
