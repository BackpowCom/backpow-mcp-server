/**
 * Tool: get_cost_of_production
 *
 * Cost of Production is a defined metric rather than a generic statistic, so
 * this handler is also where its vocabulary is established for the caller.
 * Four rules follow from that and shape the code below:
 *
 *  - an unresolvable coin is an error, never a payload built from the raw query
 *    string and placeholder literals for algorithm and price;
 *  - an upstream fetch failure and a network with no published economics
 *    document are distinct conditions and are reported distinctly, so a
 *    coverage gap is never presented as an outage or the reverse;
 *  - `electricity_cost_usd_kwh` is accepted and range-checked, because the
 *    sibling solo-odds tool takes the same key and a caller who supplies it
 *    must not be handed the reference-tariff answer as if it were personalised;
 *  - every branch of the summary names the reference machine and the applied
 *    tariff, since the figure is conditional on both.
 */

import { Enveloped, ServedFrom, coinUrl, envelope, provenance } from '../attribution.js';
import { Confidence, assertDocumentFreshness, assessCoin } from '../data/quality.js';
import { dataUnavailable, invalidArguments } from '../errors.js';
import { CoinDetailData, CoinHardwareItem, CoinHistoryPoint } from '../types.js';
import { DEFAULT_ELECTRICITY_USD_KWH, ELECTRICITY_NOTE, ToolDeps } from './deps.js';

export interface CostOfProductionArgs {
  coin_id: string;
  /** Caller's electricity tariff in USD/kWh. Omitted means BackPow's reference tariff. */
  electricity_cost_usd_kwh?: number;
}

export type CopVerdict = 'profitable' | 'underwater' | 'breakeven' | 'unknown';

export interface SufferingRating {
  score: 0 | 1 | 2 | 3;
  label: 'comfortable' | 'squeezed' | 'severe' | 'extreme';
  emoji: string;
  /** The scale travels with the value; the bare emoji is unusable on its own. */
  scale: string;
}

export interface ReferenceHardware {
  name: string | null;
  type: string | null;
  watts: number | null;
  /** Bare machine energy per coin mined at current difficulty, null when not derivable. */
  energy_kwh_per_coin: number | null;
  /** What share of the published CoP that bare energy accounts for at the applied tariff. */
  energy_cost_share_of_cop_pct: number | null;
}

export interface CopTrendEndpoint {
  date: string;
  cop_usd: number | null;
  spot_price_usd: number | null;
}

export interface CopTrend30d {
  window_points: number;
  first: CopTrendEndpoint;
  last: CopTrendEndpoint;
  cop_change_pct: number | null;
  spot_change_pct: number | null;
  /** A change of reference machine means the efficiency frontier moved. */
  reference_hardware_rotated: boolean;
  reference_hardware_changes: number;
  reference_hardware_first: string | null;
  reference_hardware_last: string | null;
}

export interface CostOfProductionData {
  coin: string;
  ticker: string;
  algorithm: string;
  spot_price_usd: number | null;
  cop_usd: number | null;
  cop_usd_at_reference_rate: number | null;
  cop_as_pct_of_spot: number | null;
  gross_margin_pct: number | null;
  verdict: CopVerdict;
  summary: string;
  reference_hardware: ReferenceHardware;
  electricity_cost_usd_kwh: number;
  electricity_cost_source: 'caller' | 'backpow_reference';
  reference_electricity_cost_usd_kwh: number;
  /** Day the CoP figure belongs to; the economics document is a daily snapshot. */
  cop_as_of_date: string | null;
  suffering: SufferingRating | null;
  trend_30d: CopTrend30d | null;
  confidence: Confidence;
}

const METHODOLOGY =
  'Cost of Production is the all-in USD cost of mining one coin on the most efficient machine ' +
  'BackPow benchmarks for the network, at the current difficulty and a stated electricity tariff. ' +
  'It is an energy-driven figure: hardware purchase price, amortisation, hosting and downtime are ' +
  'not modelled, so it is a floor on cost, not a full P&L.';

/** Beyond this a "tariff" is a typo (cents entered as dollars), not a price. */
const MAX_PLAUSIBLE_TARIFF_USD_KWH = 5;

/** Half a percent either side of parity: tighter than this is noise in a daily snapshot. */
const BREAKEVEN_BAND_PCT = 0.5;

const SUFFERING_SCALE =
  '0 comfortable (CoP below spot) · 1 🔥 squeezed (CoP 100-199% of spot) · ' +
  '2 💀 severe (200-299%) · 3 💀💀 extreme (300%+). Bands 1-3 reproduce the emoji BackPow ' +
  'publishes in its suffering index.';

/**
 * Upper edges are exclusive, matching the published suffering index, which
 * places a coin at exactly 200% of spot in the 💀 band. The rating is derived
 * here from the cost-to-price ratio rather than read from that index, so it is
 * available for every tracked network.
 */
const SUFFERING_BANDS: Array<{ below: number; value: SufferingRating }> = [
  { below: 100, value: { score: 0, label: 'comfortable', emoji: '🟢', scale: SUFFERING_SCALE } },
  { below: 200, value: { score: 1, label: 'squeezed', emoji: '🔥', scale: SUFFERING_SCALE } },
  { below: 300, value: { score: 2, label: 'severe', emoji: '💀', scale: SUFFERING_SCALE } },
  {
    below: Infinity,
    value: { score: 3, label: 'extreme', emoji: '💀💀', scale: SUFFERING_SCALE },
  },
];

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Six significant figures: CoP spans 1e-7 (Nexa) to 4e4 (Bitcoin) in the same corpus. */
function sig(value: number | null, digits = 6): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toPrecision(digits));
}

function pct(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

/** Prose money formatter. Below a cent it switches to significant figures, since a
 * fixed number of decimal places renders those values as zero. */
function usd(value: number | null): string {
  if (value === null) return 'unknown';
  if (value >= 1) {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${Number(value.toPrecision(3))}`;
}

/** The less fresh of two reads wins, so provenance never overstates freshness. */
const FRESHNESS_ORDER: ServedFrom[] = ['live', 'cache', 'stale_cache', 'bundled_snapshot'];

function worstServedFrom(a: ServedFrom, b: ServedFrom): ServedFrom {
  return FRESHNESS_ORDER.indexOf(a) >= FRESHNESS_ORDER.indexOf(b) ? a : b;
}

function findHardware(detail: CoinDetailData, name: string | null, type: string | null): CoinHardwareItem | null {
  if (!name) return null;
  const pools: CoinHardwareItem[][] =
    type === 'ASIC'
      ? [detail.ASICS]
      : type === 'GPU'
        ? [detail.GPUS]
        : type === 'CPU'
          ? [detail.CPUS]
          : [detail.ASICS, detail.GPUS, detail.CPUS];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    const hit = pool.find(h => h && h.name === name);
    if (hit) return hit;
  }
  return null;
}

interface CopReading {
  cop: number;
  date: string | null;
  miner: string | null;
  hwType: string | null;
  /** True when today's document carries no CoP and an earlier day was used. */
  fromHistory: boolean;
}

/**
 * Today's figure when there is one, otherwise the most recent day in the 30-day
 * window that carries one. The date of the figure travels with it, so a recent
 * but not same-day CoP can be returned and read for what it is.
 */
function readCop(detail: CoinDetailData, history: CoinHistoryPoint[]): CopReading | null {
  const today = positiveOrNull(detail.cop);
  const lastDate = history.length ? history[history.length - 1].date : null;
  if (today !== null) {
    return { cop: today, date: lastDate, miner: detail.copMiner, hwType: detail.copHwType, fromHistory: false };
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const point = history[i];
    const past = positiveOrNull(point.cop);
    if (past !== null) {
      return { cop: past, date: point.date, miner: point.copMiner, hwType: point.copHwType, fromHistory: true };
    }
  }
  return null;
}

function buildTrend(history: CoinHistoryPoint[], tariffFactor: number): CopTrend30d | null {
  if (!Array.isArray(history) || history.length === 0) return null;

  const withCop = history.filter(p => positiveOrNull(p.cop) !== null);
  const firstPoint = withCop.length ? withCop[0] : history[0];
  const lastPoint = withCop.length ? withCop[withCop.length - 1] : history[history.length - 1];

  const firstCop = positiveOrNull(firstPoint.cop);
  const lastCop = positiveOrNull(lastPoint.cop);
  const firstSpot = positiveOrNull(firstPoint.usdPrice);
  const lastSpot = positiveOrNull(lastPoint.usdPrice);

  const miners = history.map(p => p.copMiner).filter((m): m is string => Boolean(m));
  let changes = 0;
  for (let i = 1; i < miners.length; i++) {
    if (miners[i] !== miners[i - 1]) changes++;
  }

  return {
    window_points: history.length,
    first: {
      date: firstPoint.date,
      cop_usd: sig(firstCop === null ? null : firstCop * tariffFactor),
      spot_price_usd: sig(firstSpot),
    },
    last: {
      date: lastPoint.date,
      cop_usd: sig(lastCop === null ? null : lastCop * tariffFactor),
      spot_price_usd: sig(lastSpot),
    },
    // Percent change is invariant under the tariff rescale, so it is computed
    // on the published figures directly.
    cop_change_pct:
      firstCop !== null && lastCop !== null ? pct(((lastCop - firstCop) / firstCop) * 100) : null,
    spot_change_pct:
      firstSpot !== null && lastSpot !== null ? pct(((lastSpot - firstSpot) / firstSpot) * 100) : null,
    reference_hardware_rotated: changes > 0,
    reference_hardware_changes: changes,
    reference_hardware_first: miners.length ? miners[0] : null,
    reference_hardware_last: miners.length ? miners[miners.length - 1] : null,
  };
}

export async function handleCostOfProduction(
  args: CostOfProductionArgs,
  deps: ToolDeps
): Promise<Enveloped<CostOfProductionData>> {
  const callerTariff = args.electricity_cost_usd_kwh;
  if (callerTariff !== undefined) {
    if (!Number.isFinite(callerTariff) || callerTariff <= 0 || callerTariff > MAX_PLAUSIBLE_TARIFF_USD_KWH) {
      throw invalidArguments(
        `electricity_cost_usd_kwh must be a price in USD per kWh between 0 and ` +
          `${MAX_PLAUSIBLE_TARIFF_USD_KWH}, received ${JSON.stringify(callerTariff)}. ` +
          `Industrial hosting is around ${DEFAULT_ELECTRICITY_USD_KWH}; residential is typically 0.10-0.40.`,
        { received: callerTariff }
      );
    }
  }

  const coin = await deps.resolver.resolve(args.coin_id, deps.deadline);

  const oracleRecord = await deps.oracle.getCoin(coin.id, deps.deadline);
  if (!oracleRecord) {
    throw dataUnavailable(
      `Live telemetry for ${coin.id}`,
      'the coin resolved but the oracle currently carries no record for it'
    );
  }
  // The same freshness and completeness gate the oracle and solo-odds tools
  // apply, so all three agree on whether a network's telemetry is usable before
  // any of them draws a conclusion from it.
  const assessment = assessCoin(oracleRecord.data);

  const detailFetched = await deps.site.getCoinDetail(coin.id, deps.deadline);
  if (!detailFetched) {
    throw dataUnavailable(
      `Cost of Production for ${coin.id}`,
      'BackPow publishes no per-coin economics document for this network yet. This is a coverage ' +
        'gap, not an outage — an outage is reported as upstream_unavailable'
    );
  }

  const detail = detailFetched.data;
  const history: CoinHistoryPoint[] = Array.isArray(detail.history30d) ? detail.history30d : [];
  const reading = readCop(detail, history);
  if (!reading) {
    throw dataUnavailable(
      `Cost of Production for ${coin.id}`,
      'BackPow tracks this network but has not computed a CoP for it yet — that needs at least one ' +
        'benchmarked machine and a usable price feed, and one of the two is missing'
    );
  }

  const referenceRate = positiveOrNull(detail.copElecRate) ?? DEFAULT_ELECTRICITY_USD_KWH;
  const appliedRate = callerTariff ?? referenceRate;
  const tariffFactor = appliedRate / referenceRate;

  const copAtReference = reading.cop;
  const copUsd = copAtReference * tariffFactor;
  const spotPrice = positiveOrNull(detail.usdPrice);

  const machine = findHardware(detail, reading.miner, reading.hwType);
  const coinsPerDay =
    machine && spotPrice !== null ? positiveOrNull(machine.revenue / spotPrice) : null;
  const energyKwhPerCoin =
    machine && coinsPerDay !== null ? positiveOrNull((machine.watts * 24) / 1000 / coinsPerDay) : null;
  const energyShare =
    energyKwhPerCoin !== null ? ((energyKwhPerCoin * appliedRate) / copUsd) * 100 : null;

  const ratio = spotPrice !== null ? (copUsd / spotPrice) * 100 : null;
  const margin = spotPrice !== null ? ((spotPrice - copUsd) / spotPrice) * 100 : null;

  let verdict: CopVerdict = 'unknown';
  if (ratio !== null) {
    if (Math.abs(ratio - 100) <= BREAKEVEN_BAND_PCT) verdict = 'breakeven';
    else if (ratio > 100) verdict = 'underwater';
    else verdict = 'profitable';
  }

  const suffering =
    ratio === null ? null : (SUFFERING_BANDS.find(b => ratio < b.below) as { value: SufferingRating }).value;

  const machineLabel = reading.miner
    ? `${reading.miner}${reading.hwType ? ` (${reading.hwType})` : ''}`
    : 'the most efficient machine BackPow benchmarks for this network';
  const tariffLabel = `${appliedRate} USD/kWh`;

  // Every branch names the machine and the tariff: the figure is conditional on
  // both, and the sentence is the part most likely to be quoted on its own.
  let summary: string;
  if (verdict === 'unknown') {
    summary =
      `Mining one ${coin.ticker} on ${machineLabel} costs ${usd(sig(copUsd))} at ${tariffLabel}, but ` +
      `BackPow has no usable spot price for ${coin.id}, so no profitability verdict is given.`;
  } else if (verdict === 'underwater') {
    summary =
      `On ${machineLabel} at ${tariffLabel}, one ${coin.ticker} costs ${usd(sig(copUsd))} to produce ` +
      `against a ${usd(spotPrice)} spot price — miners are ${pct(Math.abs(margin as number), 1)}% underwater per coin.`;
  } else if (verdict === 'breakeven') {
    summary =
      `On ${machineLabel} at ${tariffLabel}, production cost (${usd(sig(copUsd))}) and spot price ` +
      `(${usd(spotPrice)}) are within half a percent of each other: operational breakeven.`;
  } else {
    summary =
      `On ${machineLabel} at ${tariffLabel}, one ${coin.ticker} costs ${usd(sig(copUsd))} to produce ` +
      `against a ${usd(spotPrice)} spot price — a ${pct(margin as number, 1)}% margin over energy and ` +
      `operating cost on that machine alone.`;
  }

  const warnings: string[] = [...assessment.warnings];

  if (callerTariff !== undefined) {
    warnings.push(
      `CoP was rescaled from BackPow's reference tariff (${referenceRate} USD/kWh) to your ` +
        `${appliedRate} USD/kWh by scaling the energy cost linearly (×${sig(tariffFactor, 4)}). ` +
        `Fixed costs — hardware purchase, amortisation, hosting, downtime — are not modelled at any ` +
        `tariff, so this remains a floor on cost.`
    );
  } else {
    warnings.push(ELECTRICITY_NOTE);
  }

  if (reading.fromHistory) {
    warnings.push(
      `No Cost of Production was published for ${coin.id} today; this figure is from ${reading.date} ` +
        `and difficulty may have moved since.`
    );
  }

  if (energyShare !== null && energyShare > 100) {
    warnings.push(
      `The reference machine's bare electricity cost at ${tariffLabel} exceeds the published CoP for ` +
        `${coin.id}. That happens where the machine's revenue includes merge-mined income, so treat ` +
        `the energy share below as a diagnostic, not a cost breakdown.`
    );
  }

  if (spotPrice === null) {
    warnings.push(
      `BackPow carries no usable USD price for ${coin.id}, so cost-to-price ratio, margin and ` +
        `suffering rating are null rather than computed against a placeholder.`
    );
  }

  const trend = buildTrend(history, tariffFactor);
  if (trend?.reference_hardware_rotated) {
    warnings.push(
      `The reference machine for ${coin.id} changed ${trend.reference_hardware_changes} time(s) in the ` +
        `last 30 days (${trend.reference_hardware_first} → ${trend.reference_hardware_last}); part of any ` +
        `CoP move is the efficiency frontier shifting, not difficulty or price.`
    );
  }

  // Economics documents are recomputed daily, so a computation date more than a
  // week old no longer describes current difficulty and is refused outright
  // rather than returned with a caveat.
  assertDocumentFreshness(`Cost of Production for ${coin.id}`, reading.date, warnings);

  const data: CostOfProductionData = {
    coin: coin.id,
    ticker: coin.ticker,
    algorithm: coin.algorithm,
    spot_price_usd: sig(spotPrice),
    cop_usd: sig(copUsd),
    cop_usd_at_reference_rate: sig(copAtReference),
    cop_as_pct_of_spot: pct(ratio),
    gross_margin_pct: pct(margin),
    verdict,
    summary,
    reference_hardware: {
      name: reading.miner,
      type: reading.hwType,
      watts: machine ? positiveOrNull(machine.watts) : null,
      energy_kwh_per_coin: sig(energyKwhPerCoin),
      energy_cost_share_of_cop_pct: pct(energyShare, 1),
    },
    electricity_cost_usd_kwh: appliedRate,
    electricity_cost_source: callerTariff !== undefined ? 'caller' : 'backpow_reference',
    reference_electricity_cost_usd_kwh: referenceRate,
    cop_as_of_date: reading.date,
    suffering,
    trend_30d: trend,
    confidence: assessment.confidence,
  };

  return envelope(
    data,
    provenance({
      asOfUtc: reading.date ? `${reading.date}T00:00:00Z` : null,
      ageSeconds: Math.max(detailFetched.ageSeconds, oracleRecord.ageSeconds),
      servedFrom: worstServedFrom(detailFetched.servedFrom, oracleRecord.servedFrom),
      dataSource: 'mixed',
      url: coinUrl(coin.id),
      subject: `${coin.id} cost of production`,
      methodology: METHODOLOGY,
    }),
    warnings
  );
}
