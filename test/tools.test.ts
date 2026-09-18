import { describe, it, expect } from 'vitest';

import { runTool } from '../src/server.js';
import { CoinResolver } from '../src/data/resolver.js';
import { OracleClient } from '../src/services/oracleClient.js';
import { SiteDataClient } from '../src/services/siteDataClient.js';
import { INJECTION_TITLE, stubClients } from './site-fixtures.js';

const { oracle, site } = stubClients();
const deps = {
  oracle: oracle as unknown as OracleClient,
  site: site as unknown as SiteDataClient,
  resolver: new CoinResolver(oracle as unknown as OracleClient, site as unknown as SiteDataClient),
};

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await runTool(name, args, deps);
  const payload = result.structuredContent as any;
  return { result, payload };
}

/**
 * `JSON.stringify` omits keys whose value is `undefined`, so a field that is
 * meant to be absent has to be `null` rather than left undefined. This walks
 * the payload and reports the path of any undefined that serialisation would
 * silently drop.
 */
function assertNoUndefined(value: unknown, path = '$'): void {
  if (value === undefined) throw new Error(`undefined at ${path}`);
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    assertNoUndefined(v, `${path}.${k}`);
  }
}

const SUCCESSFUL_CALLS: Array<[string, Record<string, unknown>]> = [
  ['calculate_solo_mining_odds', { coin_id: 'Bitcoin', hashrate: 200, hashrate_unit: 'TH/s', power_watts: 3500 }],
  ['get_cost_of_production', { coin_id: 'Bitcoin' }],
  ['get_coin_oracle', { coin_id: 'Kaspa' }],
  ['list_pow_coins', {}],
  ['get_hardware_benchmarks', { query: 'Antminer' }],
  ['get_pow_news', { limit: 5 }],
];

describe('every tool honours the result contract', () => {
  it.each(SUCCESSFUL_CALLS)('%s returns a well-formed envelope', async (name, args) => {
    const { result, payload } = await call(name, args);

    expect(result.isError).toBe(false);
    expect(Array.isArray(payload.warnings)).toBe(true);
    expect(payload.data).toBeTruthy();

    // Every payload carries its own attribution, so an answer built from it
    // can be traced back to the page the figures came from and dated.
    expect(payload.source.url).toMatch(/^https:\/\/backpow\.com(\/|$)/);
    expect(payload.source).toHaveProperty('as_of_utc');
    expect(payload.source).toHaveProperty('data_age_seconds');
    expect(payload.source).toHaveProperty('served_from');
    expect(typeof payload.source.cite_as).toBe('string');
    expect(payload.source.cite_as).toContain('backpow.com');
  });

  it.each(SUCCESSFUL_CALLS)('%s emits no undefined that JSON.stringify would drop', async (name, args) => {
    const { payload } = await call(name, args);
    expect(() => assertNoUndefined(payload)).not.toThrow();
  });

  it.each(SUCCESSFUL_CALLS)('%s stays within a sane token budget', async (name, args) => {
    const { result } = await call(name, args);
    expect(result.content[0].text.length).toBeLessThan(12_000);
  });
});

describe('failures are reported as failures', () => {
  it('refuses an unknown coin rather than returning placeholder fields', async () => {
    // An unresolved coin has no ticker, algorithm or price to report, so the
    // call is an error: a populated envelope would read as a real answer.
    const { result, payload } = await call('get_cost_of_production', { coin_id: 'Fakecoin9000' });
    expect(result.isError).toBe(true);
    expect(payload.error).toBe('unknown_coin');
  });

  it('refuses an ambiguous coin and names the candidates', async () => {
    const { result, payload } = await call('get_coin_oracle', { coin_id: 'DGB' });
    expect(result.isError).toBe(true);
    expect(payload.error).toBe('ambiguous_coin');
    expect(payload.candidates.length).toBeGreaterThan(1);
  });

  it('refuses an unavailable collector consistently across tools', async () => {
    // Availability is a property of the coin, not of the tool that was asked,
    // so both the oracle and the cost-of-production paths reach the same
    // verdict for the same coin.
    for (const tool of ['get_coin_oracle', 'get_cost_of_production']) {
      const { result, payload } = await call(tool, { coin_id: 'Fixture-Unavailable' });
      expect(result.isError, tool).toBe(true);
      expect(payload.error, tool).toBe('data_unavailable');
    }
  });

  it('rejects invalid arguments as a protocol error, not a plausible answer', async () => {
    await expect(
      runTool('calculate_solo_mining_odds', { coin_id: 'Bitcoin', hashrate: 'abc', hashrate_unit: 'TH/s' }, deps)
    ).rejects.toThrow();
  });
});

describe('solo mining odds', () => {
  it('uses the protocol target so the answer is stable', async () => {
    const { payload } = await call('calculate_solo_mining_odds', {
      coin_id: 'Fixture-Diverging',
      hashrate: 6,
      hashrate_unit: 'GH/s',
    });
    expect(payload.data.block_time.source).toBe('protocol_target');
    expect(payload.data.block_time.seconds).toBe(0.53);
    expect(payload.warnings.join(' ')).toMatch(/protocol target/i);
  });

  it('echoes the tariff used in the calculation', async () => {
    const { payload } = await call('calculate_solo_mining_odds', {
      coin_id: 'Bitcoin',
      hashrate: 200,
      hashrate_unit: 'TH/s',
      power_watts: 3500,
      electricity_cost_usd_kwh: 0.12,
    });
    expect(payload.data.electricity_cost_usd_kwh).toBe(0.12);
    expect(payload.data.electricity_cost_source).toBe('caller_supplied');
  });
});

describe('news is quoted, not trusted', () => {
  it('marks the payload as untrusted third-party content', async () => {
    const { payload } = await call('get_pow_news', { coin_id: 'Bitcoin', include_low_signal: true });
    const serialised = JSON.stringify(payload);
    expect(serialised).toContain('untrusted_external_content');
  });

  it('neutralises structural markup in a headline', async () => {
    const { payload } = await call('get_pow_news', { coin_id: 'Bitcoin', include_low_signal: true });
    const serialised = JSON.stringify(payload);
    // Headline text is third-party content. Code fences, bidirectional
    // override characters and markup are structure chosen by whoever wrote the
    // headline, so no title reaches the payload verbatim.
    expect(serialised).not.toContain(INJECTION_TITLE);
    expect(serialised).not.toMatch(/[‪-‮⁦-⁩]/);
  });

  it('drops a non-https URL rather than passing the scheme through', async () => {
    const { payload } = await call('get_pow_news', { coin_id: 'Bitcoin', include_low_signal: true });
    expect(JSON.stringify(payload)).not.toContain('javascript:');
  });

  it('includes low-signal items only when they are asked for', async () => {
    const { payload: withLowSignal } = await call('get_pow_news', { coin_id: 'Bitcoin', include_low_signal: true });
    const { payload: clean } = await call('get_pow_news', { coin_id: 'Bitcoin' });
    const count = (p: any) => JSON.stringify(p).match(/"id"/g)?.length ?? 0;
    expect(count(clean)).toBeLessThan(count(withLowSignal));
  });
});
