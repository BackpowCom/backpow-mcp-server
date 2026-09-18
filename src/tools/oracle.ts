/**
 * Tool: get_coin_oracle
 *
 * Raw current network state for one chain, straight from the stratum
 * collectors: difficulty, derived network rate, height, reward, block time and
 * the pool the observation came from.
 *
 * Four rules govern what this surface returns:
 *  - every figure travels with the data-quality field that qualifies it. A
 *    block reward carries its `reward_status`, and the record as a whole
 *    carries a confidence, so a static fallback figure is never
 *    indistinguishable from a live measurement.
 *  - zero is not a measurement. `assessCoin` refuses an unavailable or stalled
 *    record outright, and a non-positive rate is reported as null rather than
 *    as "0 H/s", which would read as a network with no hashrate.
 *  - the rate formatter follows the oracle's own unit. Networks measure work in
 *    hashes, Cuckoo graphs or Aleo proofs, so the SI prefix is rendered in the
 *    family the number actually belongs to.
 *  - unitless internal diagnostics are kept off the tool surface. A bare number
 *    with no documented range beside a status field cannot be interpreted by a
 *    caller, so only fields with stated semantics are published.
 */

import {
  Enveloped,
  ageFromEpochSeconds,
  coinUrl,
  envelope,
  isoFromEpochSeconds,
  provenance,
} from '../attribution.js';
import { dataUnavailable } from '../errors.js';
import { BlockTimeDecision, Confidence, assessCoin, resolveBlockTime } from '../data/quality.js';
import { familyFromRateUnit, formatRate } from '../math/poisson.js';
import { ToolDeps } from './deps.js';

export interface CoinOracleArgs {
  coin_id: string;
}

export interface CoinOracleRate {
  /** Base units per second, or null when the oracle reports no positive rate. */
  value: number | null;
  /** The oracle's own unit spelling: hashes_per_second, graphs_per_second, proofs_per_second. */
  unit: string;
  /** SI-prefixed rendering in that unit's family, or null when there is nothing to render. */
  formatted: string | null;
}

export interface CoinOracleBlockReward {
  value: number | null;
  /**
   * 'live' | 'static_fallback' | 'unknown'. A static fallback is the reward the
   * chain's schedule specifies rather than one read from a work template, so it
   * lags a halving or an emission change until the collector catches up.
   */
  status: string;
}

export interface CoinOracleData {
  coin_id: string;
  ticker: string;
  algorithm: string;
  block_height: number | null;
  /** Why the height is absent; null whenever a height is present. */
  height_semantics: string | null;
  network_difficulty: number | null;
  network_rate: CoinOracleRate;
  block_reward: CoinOracleBlockReward;
  block_time: BlockTimeDecision;
  source_pool: string | null;
  confidence: Confidence;
}

export async function handleCoinOracle(
  args: CoinOracleArgs,
  deps: ToolDeps
): Promise<Enveloped<CoinOracleData>> {
  const resolved = await deps.resolver.resolve(args.coin_id, deps.deadline);

  const fetched = await deps.oracle.getCoin(resolved.id, deps.deadline);
  if (!fetched) {
    throw dataUnavailable(
      `Live telemetry for ${resolved.id}`,
      'the coin resolved but is absent from the current oracle corpus'
    );
  }
  const coin = fetched.data;

  // Throws on an unavailable, stalled or >24h-old record: the fields of such a
  // record describe no current network state, and its zeros are placeholders
  // rather than measurements.
  const assessment = assessCoin(coin);
  const blockTime = resolveBlockTime(coin);

  const warnings = [...assessment.warnings];
  if (blockTime.warning) warnings.push(blockTime.warning);

  const rateFamily = familyFromRateUnit(coin.rate_unit);
  const hasRate = Number.isFinite(coin.network_hashrate) && coin.network_hashrate > 0;
  if (!hasRate) {
    warnings.push(
      `No positive network rate is currently derivable for ${coin.coin_id}; the rate is returned as ` +
        `null rather than as zero. Do not read it as "this network has no hashrate".`
    );
  }

  const hasDifficulty = Number.isFinite(coin.difficulty) && coin.difficulty > 0;
  if (!hasDifficulty) {
    warnings.push(
      `The collectors report no usable difficulty for ${coin.coin_id}, so the field is null. Any ` +
        `figure derived from difficulty is unavailable for this network right now.`
    );
  }

  const height = Number.isFinite(coin.height) ? (coin.height as number) : null;

  const data: CoinOracleData = {
    coin_id: coin.coin_id,
    ticker: coin.ticker,
    algorithm: coin.algorithm,
    block_height: height,
    height_semantics:
      height === null
        ? `No linear block height is published for ${coin.coin_id}. DAG-structured chains have no ` +
          `single canonical height, and some stratum endpoints simply do not expose one. This is an ` +
          `absent field, not a height of zero and not a collection error.`
        : null,
    network_difficulty: hasDifficulty ? coin.difficulty : null,
    network_rate: {
      value: hasRate ? coin.network_hashrate : null,
      unit: coin.rate_unit || 'hashes_per_second',
      formatted: hasRate ? formatRate(coin.network_hashrate, rateFamily) : null,
    },
    block_reward: {
      value:
        typeof coin.block_reward === 'number' && Number.isFinite(coin.block_reward)
          ? coin.block_reward
          : null,
      status: coin.reward_status || 'unknown',
    },
    block_time: blockTime,
    source_pool: coin.source_pool || null,
    confidence: assessment.confidence,
  };

  return envelope(
    data,
    provenance({
      asOfUtc: isoFromEpochSeconds(coin.observed_at),
      // The measurement clock, not the cache clock: a figure observed 40 minutes
      // ago is 40 minutes old however recently we re-read the document.
      ageSeconds: ageFromEpochSeconds(coin.observed_at) ?? fetched.ageSeconds,
      servedFrom: fetched.servedFrom,
      dataSource: 'stratum_oracle',
      url: coinUrl(coin.coin_id),
      subject: `${coin.ticker} network state`,
      methodology:
        `Observed directly from stratum pool connections: difficulty and height are read from the ` +
        `work templates, the network rate is derived as difficulty x 2^32 / block_time_target (or the ` +
        `chain's equivalent work formula), and ${coin.distinct_operators || 1} independent pool ` +
        `operator(s) are cross-checked before a reading is marked confirmed.`,
    }),
    warnings
  );
}
