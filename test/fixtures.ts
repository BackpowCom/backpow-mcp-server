/**
 * Coin fixtures: illustrative records written to exercise each code path.
 *
 * Identity records use real coin ids so that resolution is tested against the
 * naming patterns that actually occur — shared tickers, camel-case multi-word
 * names, algorithm-suffixed variants. Records that carry a degraded state use
 * synthetic ids, because the state is invented to drive a branch and describes
 * no real network.
 *
 * The values are held constant so the suite is deterministic and independent of
 * the network: no test in this directory constructs a real client.
 */

import { OracleCoin } from '../src/types.js';

function coin(partial: Partial<OracleCoin> & Pick<OracleCoin, 'coin_id' | 'ticker'>): OracleCoin {
  return {
    schema_version: 1,
    algorithm: 'SHA-256',
    family: 'bitcoin',
    height: 900_000,
    difficulty: 1.2745e14,
    network_hashrate: 8.694e20,
    block_time_target: 600,
    block_time: null,
    block_reward: 3.125,
    reward_status: 'live',
    status: 'confirmed',
    observed_at: Math.floor(Date.now() / 1000) - 30,
    source_pool: 'test-pool',
    rate_unit: 'hashes_per_second',
    distinct_operators: 5,
    agreement_count: 5,
    formula_coherence: 0,
    integration_ready: true,
    integration_blockers: [],
    ...partial,
  };
}

/**
 * A slice of the corpus chosen to exercise every resolver tier: a single-letter
 * prefix shared by several networks, a ticker carried by more than one coin id,
 * and names that are written as two words outside their canonical id.
 */
export const COINS: OracleCoin[] = [
  coin({ coin_id: 'Bitcoin', ticker: 'BTC' }),
  coin({ coin_id: 'BitcoinCash', ticker: 'BCH' }),
  coin({ coin_id: 'BitcoinGold', ticker: 'BTG', algorithm: 'Equihash' }),
  coin({ coin_id: 'Beam', ticker: 'BEAM', algorithm: 'BeamHashIII', block_time_target: 60 }),
  coin({ coin_id: 'Bells', ticker: 'BEL', algorithm: 'Scrypt' }),
  coin({ coin_id: 'Kaspa', ticker: 'KAS', algorithm: 'kHeavyHash', block_time_target: 1 }),
  coin({ coin_id: 'Kadena', ticker: 'KDA', algorithm: 'Blake2s' }),
  coin({ coin_id: 'Monero', ticker: 'XMR', algorithm: 'RandomX', block_time_target: 120 }),
  coin({ coin_id: 'EthereumClassic', ticker: 'ETC', algorithm: 'Etchash', block_time_target: 13 }),
  coin({ coin_id: 'EthereumPoW', ticker: 'ETHW', algorithm: 'Ethash', block_time_target: 13, block_time: 1 }),
  coin({ coin_id: 'DGB-Odocrypt', ticker: 'DGB', algorithm: 'Odocrypt' }),
  coin({ coin_id: 'DGB-SHA', ticker: 'DGB', algorithm: 'SHA-256' }),
  coin({ coin_id: 'DGB-Scrypt', ticker: 'DGB', algorithm: 'Scrypt' }),
  // Protocol target and most recent observed interval differ by two orders of
  // magnitude, which is what the block-time resolution rules are measured on.
  // Also unready for integration, so one record covers both branches.
  coin({
    coin_id: 'Fixture-Diverging',
    ticker: 'FIXD',
    algorithm: 'Blake3',
    block_time_target: 0.53,
    block_time: 60,
    integration_ready: false,
    integration_blockers: ['baseline_deviation'],
  }),
  // Cuckoo family: network rate is measured in graphs per second, not hashes.
  coin({
    coin_id: 'Aeternity',
    ticker: 'AE',
    algorithm: 'CuckooCycle',
    rate_unit: 'graphs_per_second',
    network_hashrate: 2772,
  }),
  coin({
    coin_id: 'Aleo',
    ticker: 'ALEO',
    algorithm: 'zkSNARK',
    rate_unit: 'proofs_per_second',
    network_hashrate: 646_820_575_977,
  }),
  // Unavailable collector: no height, no reward, zero network rate and a stale
  // observation, so every numeric answer for it has to be withheld.
  coin({
    coin_id: 'Fixture-Unavailable',
    ticker: 'FIXU',
    status: 'unavailable',
    network_hashrate: 0,
    difficulty: 0,
    height: null,
    block_reward: null,
    integration_ready: false,
    observed_at: Math.floor(Date.now() / 1000) - 172_800,
  }),
  // Sources disagree, and a reward that is not live-derived: two more branches.
  coin({ coin_id: 'Fixture-Conflicted', ticker: 'FIXC', algorithm: 'FiroPow', status: 'conflict', agreement_count: 2 }),
  coin({ coin_id: 'Fixture-StaticReward', ticker: 'FIXS', algorithm: 'Autolykos', reward_status: 'static_fallback' }),
];

/** Minimal stand-in for OracleClient, sufficient for the resolver. */
export function fakeOracle(coins: OracleCoin[] = COINS) {
  return {
    async getAllCoins() {
      return { data: coins, servedFrom: 'live' as const, ageSeconds: 0 };
    },
  };
}

export function fakeSite() {
  return {
    async getBotData() {
      return { data: [], servedFrom: 'live' as const, ageSeconds: 0 };
    },
  };
}
