/**
 * Tool: calculate_solo_mining_odds
 *
 * Given a rig rate and a network, returns the mean waiting time to a solo
 * block, the Poisson probability over standard windows, the luck spread around
 * that mean, and the electricity cost accrued while waiting.
 *
 * Three inputs decide whether the answer means anything, so each is resolved
 * explicitly and each resolution is reported back in the payload:
 *  - Block time. Mean waiting time is linear in it, so the choice between the
 *    protocol target and the most recent observed inter-block interval scales
 *    every figure proportionally. `resolveBlockTime` makes that choice and
 *    returns its reasoning, and both candidate values travel in the response.
 *  - Rate unit. Networks measure work in hashes, graphs or proofs per second,
 *    and these are not interconvertible. `parseRate` rejects an unrecognised
 *    unit, and the echoed rate is the canonical spelling rather than the
 *    caller's, so the output cannot silently reinterpret the input.
 *  - Electricity tariff. The applied rate and whether it came from the caller
 *    or from the reference default are both fields of the result, so a cost
 *    figure is never read as personalised when it is not.
 */

import { Enveloped, coinUrl, envelope, isoFromEpochSeconds, provenance, soloPoolsUrl, ageFromEpochSeconds } from '../attribution.js';
import { dataUnavailable, invalidArguments } from '../errors.js';
import { Confidence, assessCoin, resolveBlockTime } from '../data/quality.js';
import {
  PROBABILITY_NOTE,
  RateFamily,
  calculateExponentialQuantile,
  calculatePoissonProbability,
  familyFromRateUnit,
  formatDuration,
  formatRate,
  parseRate,
} from '../math/poisson.js';
import { DEFAULT_ELECTRICITY_USD_KWH, ELECTRICITY_NOTE, ToolDeps } from './deps.js';

export interface SoloOddsArgs {
  coin_id: string;
  hashrate: number;
  hashrate_unit: string;
  power_watts?: number;
  electricity_cost_usd_kwh?: number;
}

export interface DurationFigure {
  seconds: number;
  human_readable: string;
}

export interface SoloOddsBlockTime {
  seconds: number;
  source: 'protocol_target' | 'observed_sample';
  target_seconds: number | null;
  observed_seconds: number | null;
  /** Signed percent by which the observed sample differs from the target. */
  disagreement_pct: number | null;
}

export interface SoloOddsBlockReward {
  value: number | null;
  /**
   * 'live' when the figure comes from an observed coinbase, 'static_fallback'
   * when it comes from the chain's published schedule, 'unknown' otherwise.
   */
  status: string;
}

export interface SoloOddsMethodology {
  model: 'poisson_process';
  mean_waiting_time_formula: string;
  probability_formula: string;
  network_rate_source: 'stratum_oracle';
  block_time_source: 'protocol_target' | 'observed_sample';
  spot_price_source: 'site_snapshot' | null;
  electricity_cost_usd_kwh: number;
}

export interface SoloOddsData {
  coin_id: string;
  ticker: string;
  algorithm: string;
  resolved_via: string;
  matched_query: string | null;

  miner_hashrate_formatted: string;
  miner_rate_per_second: number;
  miner_rate_family: RateFamily;
  network_hashrate_formatted: string | null;
  network_rate_per_second: number;
  network_rate_family: RateFamily;
  network_difficulty: number | null;

  block_time: SoloOddsBlockTime;
  block_reward: SoloOddsBlockReward;
  spot_price_usd: number | null;

  electricity_cost_usd_kwh: number;
  electricity_cost_source: 'caller_supplied' | 'default';
  power_watts: number | null;

  average_time_to_block: {
    seconds: number;
    hours: number;
    days: number;
    years: number;
    human_readable: string;
  };
  expected_blocks_per_day: number;
  poisson_probabilities: {
    '1_day_pct': number;
    '7_days_pct': number;
    '30_days_pct': number;
    '90_days_pct': number;
    '365_days_pct': number;
  };
  variance_estimates: {
    lucky_5th_percentile: DurationFigure;
    median_50th_percentile: DurationFigure;
    dry_spell_95th_percentile: DurationFigure;
  };

  estimated_power_cost_usd_per_block: number | null;
  daily_power_cost_usd: number | null;
  expected_daily_revenue_usd: number | null;

  solo_pools_url: string;
  confidence: Confidence;
  methodology: SoloOddsMethodology;
  limitations: string[];
}

const DAY_SECONDS = 86_400;

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** USD figures span cents to millionths across the corpus, so below a cent this keeps
 * three significant figures instead of rounding to 2dp. */
function roundUsd(value: number): number {
  return Math.abs(value) >= 0.01 ? Number(value.toFixed(2)) : Number(value.toPrecision(3));
}

function duration(seconds: number): DurationFigure {
  return { seconds: Math.round(seconds), human_readable: formatDuration(seconds) };
}

const FAMILY_PROSE: Record<RateFamily, string> = {
  hash: 'hashes per second',
  graph: 'graphs per second (Cuckoo-family)',
  proof: 'proofs per second',
};

export async function handleSoloOdds(
  args: SoloOddsArgs,
  deps: ToolDeps
): Promise<Enveloped<SoloOddsData>> {
  const resolved = await deps.resolver.resolve(args.coin_id, deps.deadline);

  const fetched = await deps.oracle.getCoin(resolved.id, deps.deadline);
  if (!fetched) {
    throw dataUnavailable(
      `Live telemetry for ${resolved.id}`,
      'the coin resolved but is absent from the current oracle corpus'
    );
  }
  const coin = fetched.data;

  // Throws rather than returning zeros when the telemetry cannot carry a number.
  const assessment = assessCoin(coin, { requireNumbers: true });
  const blockTime = resolveBlockTime(coin);

  const warnings = [...assessment.warnings];
  if (blockTime.warning) warnings.push(blockTime.warning);

  const minerRate = parseRate(args.hashrate, args.hashrate_unit);
  const networkFamily = familyFromRateUnit(coin.rate_unit);
  if (minerRate.family !== networkFamily) {
    // Refuse rather than warn. The division would still produce a number, but
    // it divides two incommensurable quantities: on a Cuckoo chain a rig quoted
    // in GH/s yields a mean time that rounds to zero and probabilities pinned at
    // the ceiling. A caveat attached to a figure like that is easy to drop when
    // the figure is quoted on its own, so the call fails instead.
    throw invalidArguments(
      `Unit mismatch: the rig rate was given in ${FAMILY_PROSE[minerRate.family]} ` +
        `(${minerRate.canonical}), but ${coin.coin_id}'s network rate is measured in ` +
        `${FAMILY_PROSE[networkFamily]}. These are different physical quantities and are not ` +
        `convertible, so no meaningful probability can be computed. Re-run with the rig's rate ` +
        `expressed in ${FAMILY_PROSE[networkFamily]}.`,
      {
        coin_id: coin.coin_id,
        network_rate_unit: coin.rate_unit,
        supplied_unit: minerRate.canonical,
      }
    );
  }

  const networkRate = coin.network_hashrate;
  const avgSeconds = (networkRate / minerRate.perSecond) * blockTime.seconds;
  const blocksPerDay = DAY_SECONDS / avgSeconds;

  const t05 = calculateExponentialQuantile(0.05, avgSeconds);
  const t50 = calculateExponentialQuantile(0.5, avgSeconds);
  const t95 = calculateExponentialQuantile(0.95, avgSeconds);

  const elecRate = args.electricity_cost_usd_kwh ?? DEFAULT_ELECTRICITY_USD_KWH;
  const elecSource: 'caller_supplied' | 'default' =
    args.electricity_cost_usd_kwh === undefined ? 'default' : 'caller_supplied';
  if (elecSource === 'default') warnings.push(ELECTRICITY_NOTE);

  const watts =
    typeof args.power_watts === 'number' && args.power_watts > 0 ? args.power_watts : null;
  const dailyPowerCost = watts === null ? null : roundUsd(((watts * 24) / 1000) * elecRate);
  const powerCostPerBlock =
    watts === null ? null : roundUsd(((watts * (avgSeconds / 3600)) / 1000) * elecRate);

  // Spot price enriches the answer but is not part of it: the odds depend only
  // on rates and block time, so an unavailable price document degrades to null
  // plus a caveat rather than failing the call.
  let spot: number | null = null;
  let spotUnavailable = false;
  try {
    const detail = await deps.site.getCoinDetail(resolved.id, deps.deadline);
    const price = detail?.data.usdPrice;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) spot = price;
    else spotUnavailable = true;
  } catch {
    spotUnavailable = true;
  }

  const reward =
    typeof coin.block_reward === 'number' && Number.isFinite(coin.block_reward)
      ? coin.block_reward
      : null;
  const dailyRevenue =
    spot !== null && reward !== null && Number.isFinite(blocksPerDay)
      ? roundUsd(reward * spot * blocksPerDay)
      : null;
  if (dailyRevenue === null) {
    warnings.push(
      spotUnavailable || spot === null
        ? `No spot price is currently available for ${coin.ticker}, so expected revenue is returned ` +
          `as null rather than guessed. Power cost is still exact.`
        : `No block reward is published for ${coin.coin_id}, so expected revenue cannot be computed.`
    );
  }

  const usedSite = spot !== null;
  const data: SoloOddsData = {
    coin_id: coin.coin_id,
    ticker: coin.ticker,
    algorithm: coin.algorithm,
    resolved_via: resolved.resolved_via,
    matched_query: resolved.matched_query ?? null,

    miner_hashrate_formatted: `${args.hashrate} ${minerRate.canonical}`,
    miner_rate_per_second: minerRate.perSecond,
    miner_rate_family: minerRate.family,
    network_hashrate_formatted: formatRate(networkRate, networkFamily),
    network_rate_per_second: networkRate,
    network_rate_family: networkFamily,
    network_difficulty:
      Number.isFinite(coin.difficulty) && coin.difficulty > 0 ? coin.difficulty : null,

    block_time: {
      seconds: blockTime.seconds,
      source: blockTime.source,
      target_seconds: blockTime.target_seconds,
      observed_seconds: blockTime.observed_seconds,
      disagreement_pct: blockTime.disagreement_pct,
    },
    block_reward: { value: reward, status: coin.reward_status || 'unknown' },
    spot_price_usd: spot,

    electricity_cost_usd_kwh: elecRate,
    electricity_cost_source: elecSource,
    power_watts: watts,

    average_time_to_block: {
      seconds: Math.round(avgSeconds),
      hours: round(avgSeconds / 3600, 2),
      days: round(avgSeconds / DAY_SECONDS, 2),
      years: round(avgSeconds / DAY_SECONDS / 365.25, 2),
      human_readable: formatDuration(avgSeconds),
    },
    expected_blocks_per_day: Number(blocksPerDay.toPrecision(4)),
    poisson_probabilities: {
      '1_day_pct': calculatePoissonProbability(DAY_SECONDS, avgSeconds),
      '7_days_pct': calculatePoissonProbability(7 * DAY_SECONDS, avgSeconds),
      '30_days_pct': calculatePoissonProbability(30 * DAY_SECONDS, avgSeconds),
      '90_days_pct': calculatePoissonProbability(90 * DAY_SECONDS, avgSeconds),
      '365_days_pct': calculatePoissonProbability(365 * DAY_SECONDS, avgSeconds),
    },
    variance_estimates: {
      lucky_5th_percentile: duration(t05),
      median_50th_percentile: duration(t50),
      dry_spell_95th_percentile: duration(t95),
    },

    estimated_power_cost_usd_per_block: powerCostPerBlock,
    daily_power_cost_usd: dailyPowerCost,
    expected_daily_revenue_usd: dailyRevenue,

    solo_pools_url: soloPoolsUrl(coin.coin_id),
    confidence: assessment.confidence,
    methodology: {
      model: 'poisson_process',
      mean_waiting_time_formula: 'T = (network_rate / miner_rate) * block_time_seconds',
      probability_formula: 'P(at least 1 block in t) = 1 - exp(-t / T)',
      network_rate_source: 'stratum_oracle',
      block_time_source: blockTime.source,
      spot_price_source: usedSite ? 'site_snapshot' : null,
      electricity_cost_usd_kwh: elecRate,
    },
    limitations: buildLimitations({
      coinId: coin.coin_id,
      blockTimeSource: blockTime.source,
      blockTimeSeconds: blockTime.seconds,
      elecRate,
      elecSource,
      lucky: formatDuration(t05),
      dry: formatDuration(t95),
      rewardStatus: coin.reward_status || 'unknown',
    }),
  };

  return envelope(
    data,
    provenance({
      asOfUtc: isoFromEpochSeconds(coin.observed_at),
      // Age is measured from the observation, not from the read: a figure
      // observed 40 minutes ago is 40 minutes old however recently the document
      // was fetched. Cache freshness is carried separately by `served_from`.
      ageSeconds: ageFromEpochSeconds(coin.observed_at) ?? fetched.ageSeconds,
      servedFrom: fetched.servedFrom,
      dataSource: usedSite ? 'mixed' : 'stratum_oracle',
      url: coinUrl(coin.coin_id),
      subject: `${coin.ticker} solo mining odds`,
      methodology:
        `Poisson waiting-time model over BackPow stratum telemetry: T = (network_rate / miner_rate) ` +
        `x block_time, with block time taken from the ${blockTime.source === 'protocol_target' ? 'protocol target' : 'most recent observed sample'}.`,
    }),
    warnings
  );
}

function buildLimitations(input: {
  coinId: string;
  blockTimeSource: 'protocol_target' | 'observed_sample';
  blockTimeSeconds: number;
  elecRate: number;
  elecSource: 'caller_supplied' | 'default';
  lucky: string;
  dry: string;
  rewardStatus: string;
}): string[] {
  const limitations = [
    `Difficulty is held constant for the whole window. Real difficulty retargets, so the longer ` +
      `the horizon the more the figures drift — a 365-day number is an illustration, not a forecast.`,
    input.blockTimeSource === 'protocol_target'
      ? `Block time uses ${input.coinId}'s protocol target of ${input.blockTimeSeconds}s. A network ` +
        `persistently running fast or slow shifts every figure here proportionally.`
      : `No protocol block-time target is published for ${input.coinId}, so a single observed ` +
        `inter-block sample (${input.blockTimeSeconds}s) drives every figure. Treat the magnitude, ` +
        `not the digits, as meaningful.`,
    input.elecSource === 'default'
      ? `Power cost assumes the BackPow reference tariff of ${input.elecRate} USD/kWh because the ` +
        `caller supplied none. Residential rates are commonly 3-5x higher.`
      : `Power cost uses the caller-supplied tariff of ${input.elecRate} USD/kWh and excludes ` +
        `hosting, cooling and hardware amortisation.`,
    `Solo mining is a lottery, not a schedule: the 5th-to-95th percentile waiting time spans ` +
      `${input.lucky} to ${input.dry}. At low hashrate variance dominates the mean, and the median ` +
      `outcome is always shorter than the mean.`,
    PROBABILITY_NOTE,
  ];

  if (input.rewardStatus !== 'live') {
    limitations.push(
      `The block reward is a ${input.rewardStatus} value rather than a live coinbase observation, ` +
        `so expected revenue inherits that uncertainty.`
    );
  }

  return limitations;
}
