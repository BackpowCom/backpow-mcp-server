/**
 * Tool: get_hardware_benchmarks
 *
 * The question this tool exists to answer is "what should I mine with an
 * RTX 4090 at my electricity rate". Five properties of the answer follow from
 * that:
 *
 *  - the ranked quantity is money. `coins-data/{Coin}.json` carries `revenue`
 *    and `profitability` per machine, related by
 *    `profitability = revenue - watts * 24 / 1000 * copElecRate`. Efficiency
 *    per watt cannot take that role: it is a rate divided by power, and rates
 *    on different algorithms are different quantities, so the figures differ by
 *    many orders of magnitude for unit reasons alone.
 *  - both truncations are by net USD per day and are declared in the payload.
 *    A device supports dozens of coins and a class query matches hundreds of
 *    devices, so an ordering that is not by the ranked quantity would hide
 *    exactly the rows the caller asked for.
 *  - `limit` and `type` are honoured, and a query shorter than
 *    MIN_QUERY_LENGTH is refused: a single letter matches almost the whole
 *    index, which is a serialisation cost rather than an answer.
 *  - price provenance travels with the price. Index entries may be modelled
 *    rather than observed, or rest on a single listing, and a bare median would
 *    read like a market quote in either case.
 *  - every entry's `slug` is emitted, so each device links to its hardware page
 *    and each row to its coin x rig combo page.
 */

import {
  Enveloped,
  ServedFrom,
  coinUrl,
  comboUrl,
  envelope,
  hardwareUrl,
  provenance,
} from '../attribution.js';
import { ToolError, invalidArguments } from '../errors.js';
import { RateFamily, familyFromRateUnit, formatRate } from '../math/poisson.js';
import {
  CoinDetailData,
  CoinHardwareItem,
  HardwareIndexCoin,
  HardwareIndexEntry,
  HardwarePrice,
  OracleCoin,
} from '../types.js';
import { DEFAULT_ELECTRICITY_USD_KWH, ELECTRICITY_NOTE, ToolDeps } from './deps.js';

export interface HardwareArgs {
  query: string;
  type?: 'ASIC' | 'GPU' | 'CPU';
  /** Restrict the per-device coin rows to one network. */
  coin_id?: string;
  electricity_cost_usd_kwh?: number;
  limit?: number;
}

export type NetBasis = 'backpow_published' | 'recomputed_at_your_rate' | 'not_evaluated';

export interface HardwarePriceView {
  median_usd: number | null;
  min_usd: number | null;
  max_usd: number | null;
  currency: string;
  condition: string | null;
  /** Number of observed listings behind the figure; one carries no spread. */
  observed_listings: number | null;
  /** True when the price is modelled from comparable hardware rather than observed. */
  estimated: boolean;
  caveat: string | null;
}

export interface HardwareCoinRow {
  coin_id: string;
  algorithm: string | null;
  hashrate: number | null;
  hashrate_formatted: string | null;
  power_watts: number | null;
  /** Comparable only against machines on the same algorithm. Null, never 0. */
  efficiency_per_watt: number | null;
  efficiency_unit: string | null;
  revenue_usd_day: number | null;
  power_cost_usd_day: number | null;
  net_usd_day: number | null;
  net_basis: NetBasis;
  coin_url: string;
  combo_url: string;
}

export interface HardwareDevice {
  name: string;
  slug: string;
  type: string;
  hardware_url: string;
  market_price_usd: HardwarePriceView | null;
  best_coin_id: string | null;
  best_net_usd_day: number | null;
  profitable_coin_count: number | null;
  /** Median price divided by the best net day, when both are known and positive. */
  payback_days_at_best_coin: number | null;
  supported_coin_count: number;
  evaluated_coin_count: number;
  returned_coin_count: number;
  has_more_coins: boolean;
  coins: HardwareCoinRow[];
}

export interface HardwareData {
  query: string;
  type_filter: 'ASIC' | 'GPU' | 'CPU' | null;
  coin_filter: string | null;
  summary: string;
  ranking: string;
  electricity_cost_usd_kwh: number;
  electricity_cost_source: 'caller' | 'backpow_reference';
  returned_count: number;
  total_count: number;
  has_more: boolean;
  /** Distinct coins the matched devices support, and how many were priced. */
  coins_considered: number;
  coins_evaluated: number;
  devices: HardwareDevice[];
}

const METHODOLOGY =
  'Hashrate and power draw per device and coin come from BackPow\'s hardware index. Gross revenue is ' +
  'the USD value a machine mines in 24h at current difficulty and spot price; net subtracts ' +
  'electricity only — pool fees, hardware amortisation, hosting and downtime are not modelled, so ' +
  'net is a ceiling on profit, not a P&L. Devices and coins are ranked by net USD per day at the ' +
  'stated tariff. Efficiency is comparable only between machines running the same algorithm.';

const MIN_QUERY_LENGTH = 2;
const DEFAULT_DEVICE_LIMIT = 5;
const MAX_DEVICE_LIMIT = 25;
const MAX_COIN_ROWS_PER_DEVICE = 8;

/**
 * A coin document prices every machine on that network at once, so the cost of
 * this join is the number of distinct coins, not the number of devices. 64
 * comfortably covers the widest single-device case — a modern GPU supports
 * dozens of networks — while keeping a broad class query from pulling the whole
 * coin corpus; the deadline check between batches is the real bound.
 */
const MAX_COIN_DETAIL_FETCHES = 64;
const COIN_DETAIL_BATCH = 12;
/** Do not start another batch with less than this left of the call budget. */
const DETAIL_DEADLINE_FLOOR_MS = 1_200;

const EFFICIENCY_UNIT: Record<RateFamily, string> = {
  hash: 'H/W',
  graph: 'graphs/W',
  proof: 'proofs/W',
};

const FRESHNESS_ORDER: ServedFrom[] = ['live', 'cache', 'stale_cache', 'bundled_snapshot'];

/** The less fresh of two reads wins, so provenance never overstates freshness. */
function worstServedFrom(a: ServedFrom, b: ServedFrom): ServedFrom {
  return FRESHNESS_ORDER.indexOf(a) >= FRESHNESS_ORDER.indexOf(b) ? a : b;
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** USD/day to the cent-fraction upstream publishes, with -0 normalised away. */
function usdPerDay(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(4));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function sig(value: number | null, digits = 6): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toPrecision(digits));
}

/** Prose money. Daily figures span $61 (an Antminer Z15 Pro) to fractions of a cent. */
function usd(value: number | null): string {
  if (value === null) return 'unknown';
  const abs = Math.abs(value);
  if (abs >= 1) {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (abs >= 0.005) return `$${value.toFixed(2)}`;
  if (abs === 0) return '$0.00';
  return `$${Number(value.toPrecision(2))}`;
}

function slugify(value: string): string {
  return value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Relevance tiers. Type and coin matches are kept because "GPU" and "Kaspa" are
 * both things a model asks with, but they rank below a name match so a literal
 * model number is never buried under the hundreds of devices that merely share
 * its class.
 */
function relevance(entry: HardwareIndexEntry, q: string, qSlug: string): number {
  const name = (entry.name || '').toLowerCase();
  const slug = (entry.slug || '').toLowerCase();
  if (name === q || slug === q || (qSlug !== '' && slug === qSlug)) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if (qSlug !== '' && slug.includes(qSlug)) return 50;
  if ((entry.type || '').toLowerCase() === q) return 30;
  if (Array.isArray(entry.coins) && entry.coins.some(c => (c?.coinId || '').toLowerCase().includes(q))) {
    return 20;
  }
  return 0;
}

function suggestHardware(entries: HardwareIndexEntry[], q: string): string[] {
  const tokens = q.split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (tokens.length === 0) return [];
  return entries
    .map(entry => {
      const name = (entry.name || '').toLowerCase();
      let score = 0;
      for (const token of tokens) if (name.includes(token)) score += token.length;
      return { name: entry.name, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 5)
    .map(s => s.name);
}

function priceView(price: HardwarePrice | null | undefined): HardwarePriceView | null {
  if (!price || typeof price !== 'object') return null;

  const listings = finiteOrNull(price.count);
  const estimated = Boolean(price.estimated);
  let caveat: string | null = null;
  if (estimated) {
    caveat =
      'Modelled price, not an observed listing — BackPow estimates it from comparable hardware. ' +
      'Treat it as an order of magnitude.';
  } else if (listings !== null && listings <= 1) {
    caveat = 'Based on a single observed listing, so it carries no spread information.';
  }

  return {
    median_usd: positiveOrNull(price.median),
    min_usd: positiveOrNull(price.min),
    max_usd: positiveOrNull(price.max),
    currency: typeof price.currency === 'string' && price.currency ? price.currency : 'USD',
    condition: typeof price.condition === 'string' && price.condition ? price.condition : null,
    observed_listings: listings,
    estimated,
    caveat,
  };
}

/** Machine name to its economics on one coin. The join is by exact name upstream. */
function indexMachines(detail: CoinDetailData): Map<string, CoinHardwareItem> {
  const map = new Map<string, CoinHardwareItem>();
  for (const pool of [detail.ASICS, detail.GPUS, detail.CPUS]) {
    if (!Array.isArray(pool)) continue;
    for (const item of pool) {
      if (!item || typeof item.name !== 'string') continue;
      const key = item.name.toLowerCase();
      if (!map.has(key)) map.set(key, item);
    }
  }
  return map;
}

interface LoadedDetails {
  /** Keyed by lowercased coin id. */
  byCoin: Map<string, CoinDetailData>;
  machines: Map<string, Map<string, CoinHardwareItem>>;
  /** Coins whose document could not be read on this call (a fetch failure, not a coverage gap). */
  unavailable: number;
  /** Coins BackPow publishes no economics document for. */
  absent: number;
  /** True when the deadline stopped us before every selected coin was read. */
  deadlineTruncated: boolean;
  servedFrom: ServedFrom;
  ageSeconds: number;
  /** Oldest history date across the documents read, as an ISO day. */
  oldestDate: string | null;
}

async function loadCoinDetails(coinIds: string[], deps: ToolDeps): Promise<LoadedDetails> {
  const loaded: LoadedDetails = {
    byCoin: new Map(),
    machines: new Map(),
    unavailable: 0,
    absent: 0,
    deadlineTruncated: false,
    servedFrom: 'live',
    ageSeconds: 0,
    oldestDate: null,
  };

  for (let i = 0; i < coinIds.length; i += COIN_DETAIL_BATCH) {
    if (deps.deadline.remaining() < DETAIL_DEADLINE_FLOOR_MS) {
      loaded.deadlineTruncated = true;
      break;
    }
    const batch = coinIds.slice(i, i + COIN_DETAIL_BATCH);
    const results = await Promise.all(
      batch.map(async id => {
        try {
          return await deps.site.getCoinDetail(id, deps.deadline);
        } catch {
          // A ranking spans dozens of networks, so one unreadable document
          // must not fail the whole call; the failure is counted and
          // surfaced as a warning instead.
          return 'error' as const;
        }
      })
    );

    results.forEach((result, j) => {
      if (result === 'error') {
        loaded.unavailable++;
        return;
      }
      if (result === null) {
        loaded.absent++;
        return;
      }
      const key = batch[j].toLowerCase();
      loaded.byCoin.set(key, result.data);
      loaded.machines.set(key, indexMachines(result.data));
      loaded.servedFrom = worstServedFrom(loaded.servedFrom, result.servedFrom);
      loaded.ageSeconds = Math.max(loaded.ageSeconds, result.ageSeconds);

      const history = result.data.history30d;
      const last = Array.isArray(history) && history.length ? history[history.length - 1].date : null;
      if (typeof last === 'string' && (loaded.oldestDate === null || last < loaded.oldestDate)) {
        loaded.oldestDate = last;
      }
    });
  }

  return loaded;
}

interface RowBuild {
  row: HardwareCoinRow;
  net: number | null;
}

function buildRow(
  deviceName: string,
  deviceSlug: string,
  support: HardwareIndexCoin,
  loaded: LoadedDetails,
  oracleById: Map<string, OracleCoin>,
  appliedRate: number
): RowBuild {
  const coinId = support.coinId;
  const key = coinId.toLowerCase();
  const detail = loaded.byCoin.get(key) ?? null;
  const machine = loaded.machines.get(key)?.get(deviceName.toLowerCase()) ?? null;
  const oracleCoin = oracleById.get(key) ?? null;

  const hashrate = positiveOrNull(support.hashrate);
  const watts = positiveOrNull(support.watts);
  const family = oracleCoin ? familyFromRateUnit(oracleCoin.rate_unit) : null;

  const revenue = machine ? finiteOrNull(machine.revenue) : null;
  const referenceRate = detail ? (positiveOrNull(detail.copElecRate) ?? DEFAULT_ELECTRICITY_USD_KWH) : null;
  const powerCost = watts !== null ? (watts * 24) / 1000 * appliedRate : null;

  let net: number | null = null;
  let basis: NetBasis = 'not_evaluated';
  if (machine && referenceRate !== null) {
    if (Math.abs(referenceRate - appliedRate) < 1e-9) {
      net = finiteOrNull(machine.profitability);
      basis = net === null ? 'not_evaluated' : 'backpow_published';
    } else if (revenue !== null && powerCost !== null) {
      net = revenue - powerCost;
      basis = 'recomputed_at_your_rate';
    }
  }

  return {
    net,
    row: {
      coin_id: coinId,
      algorithm: oracleCoin?.algorithm ?? detail?.Algorithm ?? null,
      hashrate,
      // A rate with no known family is left unformatted rather than labelled
      // H/s: Cuckoo chains report graphs and Aleo reports proofs.
      hashrate_formatted: hashrate !== null && family !== null ? formatRate(hashrate, family) : null,
      power_watts: watts,
      efficiency_per_watt: hashrate !== null && watts !== null ? sig(hashrate / watts) : null,
      efficiency_unit: hashrate !== null && watts !== null && family !== null ? EFFICIENCY_UNIT[family] : null,
      revenue_usd_day: usdPerDay(revenue),
      power_cost_usd_day: usdPerDay(powerCost),
      net_usd_day: usdPerDay(net),
      net_basis: basis,
      coin_url: coinUrl(coinId),
      combo_url: comboUrl(coinId, deviceSlug),
    },
  };
}

interface DeviceBuild {
  entry: HardwareIndexEntry;
  score: number;
  rows: RowBuild[];
  bestNet: number | null;
  bestCoinId: string | null;
  evaluated: number;
  profitable: number;
}

export async function handleHardware(
  args: HardwareArgs,
  deps: ToolDeps
): Promise<Enveloped<HardwareData>> {
  const rawQuery = typeof args.query === 'string' ? args.query.trim() : '';
  if (rawQuery.length < MIN_QUERY_LENGTH) {
    throw invalidArguments(
      `query must be at least ${MIN_QUERY_LENGTH} characters after trimming — a one-character query ` +
        `matches almost every tracked device, which is too ambiguous to rank. Name a model ` +
        `("RTX 4090", "Antminer S21") or pair a class with the type argument.`,
      { received: args.query }
    );
  }

  const q = rawQuery.toLowerCase();
  const qSlug = slugify(q);
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_DEVICE_LIMIT), 1), MAX_DEVICE_LIMIT);
  const callerRate = args.electricity_cost_usd_kwh;
  const appliedRate = callerRate ?? DEFAULT_ELECTRICITY_USD_KWH;

  // Resolution throws on an unknown or ambiguous coin; the raw argument must
  // never survive as a fallback, because it reaches a URL path downstream.
  const coinFilter = args.coin_id ? await deps.resolver.resolve(args.coin_id, deps.deadline) : null;

  const indexFetched = await deps.site.getHardwareIndex(deps.deadline);
  const index = Array.isArray(indexFetched.data) ? indexFetched.data : [];

  const typeFilter = args.type ?? null;
  const pool = typeFilter
    ? index.filter(e => (e?.type || '').toUpperCase() === typeFilter)
    : index.filter(e => Boolean(e));

  const supports = (entry: HardwareIndexEntry, coinId: string): boolean =>
    Array.isArray(entry.coins) && entry.coins.some(c => (c?.coinId || '').toLowerCase() === coinId.toLowerCase());

  const matched: Array<{ entry: HardwareIndexEntry; score: number }> = [];
  for (const entry of pool) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.slug !== 'string') continue;
    const score = relevance(entry, q, qSlug);
    if (score === 0) continue;
    if (coinFilter && !supports(entry, coinFilter.id)) continue;
    matched.push({ entry, score });
  }

  if (matched.length === 0) {
    const scope =
      (typeFilter ? ` of type ${typeFilter}` : '') +
      (coinFilter ? ` that mine ${coinFilter.id}` : '');
    throw new ToolError(
      'unknown_hardware',
      `No hardware${scope} matches "${rawQuery}". Devices are indexed by model name, so try the ` +
        `model as printed on the machine.`,
      {
        query: rawQuery,
        type: typeFilter,
        coin_id: coinFilter ? coinFilter.id : null,
        did_you_mean: suggestHardware(pool, q),
      }
    );
  }

  // Oracle records supply the algorithm and the rate unit per coin. They are
  // labels, not figures, so an oracle outage degrades the labels rather than
  // failing a call whose economics come from the site documents.
  const oracleById = new Map<string, OracleCoin>();
  let oracleKnown = true;
  try {
    const coins = await deps.oracle.getAllCoins(deps.deadline);
    for (const coin of coins.data) oracleById.set(coin.coin_id.toLowerCase(), coin);
  } catch {
    oracleKnown = false;
  }

  // Coins are fetched once for the whole result set: one document prices every
  // machine on that network, so devices are ranked against the same coin subset.
  const frequency = new Map<string, { id: string; count: number }>();
  for (const { entry } of matched) {
    const coins = Array.isArray(entry.coins) ? entry.coins : [];
    for (const support of coins) {
      const id = support?.coinId;
      if (typeof id !== 'string' || id === '') continue;
      if (coinFilter && id.toLowerCase() !== coinFilter.id.toLowerCase()) continue;
      const key = id.toLowerCase();
      const seen = frequency.get(key);
      if (seen) seen.count++;
      else frequency.set(key, { id, count: 1 });
    }
  }

  const orderedCoinIds = [...frequency.values()]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .map(c => c.id);
  const selectedCoinIds = orderedCoinIds.slice(0, MAX_COIN_DETAIL_FETCHES);
  const loaded = await loadCoinDetails(selectedCoinIds, deps);

  const devices: DeviceBuild[] = matched.map(({ entry, score }) => {
    const supported = Array.isArray(entry.coins) ? entry.coins : [];
    const rows = supported
      .filter(support => {
        if (!support || typeof support.coinId !== 'string') return false;
        return !coinFilter || support.coinId.toLowerCase() === coinFilter.id.toLowerCase();
      })
      .map(support => buildRow(entry.name, entry.slug, support, loaded, oracleById, appliedRate));

    let bestNet: number | null = null;
    let bestCoinId: string | null = null;
    let evaluated = 0;
    let profitable = 0;
    for (const built of rows) {
      if (built.net === null) continue;
      evaluated++;
      if (built.net > 0) profitable++;
      if (bestNet === null || built.net > bestNet) {
        bestNet = built.net;
        bestCoinId = built.row.coin_id;
      }
    }

    // Paying coins first: the row list is truncated per device, so it must be
    // ordered by the quantity the caller is asking about. Coins with no net
    // figure sort last rather than as break-even ones.
    rows.sort((a, b) => {
      if (a.net === null && b.net === null) return a.row.coin_id.localeCompare(b.row.coin_id);
      if (a.net === null) return 1;
      if (b.net === null) return -1;
      if (a.net !== b.net) return b.net - a.net;
      return a.row.coin_id.localeCompare(b.row.coin_id);
    });

    return { entry, score, rows, bestNet, bestCoinId, evaluated, profitable };
  });

  devices.sort((a, b) => {
    // An exactly-named device is never ranked out of its own result set.
    const aExact = a.score === 100 ? 0 : 1;
    const bExact = b.score === 100 ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    if (a.bestNet === null && b.bestNet !== null) return 1;
    if (b.bestNet === null && a.bestNet !== null) return -1;
    if (a.bestNet !== null && b.bestNet !== null && a.bestNet !== b.bestNet) {
      return b.bestNet - a.bestNet;
    }
    if (a.score !== b.score) return b.score - a.score;
    return a.entry.name.localeCompare(b.entry.name);
  });

  const returned = devices.slice(0, limit);
  const coinRowLimit = coinFilter ? 1 : MAX_COIN_ROWS_PER_DEVICE;

  let anyEstimatedPrice = false;
  let anyPayback = false;
  let anyEfficiency = false;
  let anyRecomputed = false;

  const deviceViews: HardwareDevice[] = returned.map(device => {
    const price = priceView(device.entry.price);
    if (price && (price.estimated || (price.observed_listings !== null && price.observed_listings <= 1))) {
      anyEstimatedPrice = true;
    }
    const payback =
      price && price.median_usd !== null && device.bestNet !== null && device.bestNet > 0
        ? Number((price.median_usd / device.bestNet).toFixed(1))
        : null;
    if (payback !== null) anyPayback = true;

    const rows = device.rows.slice(0, coinRowLimit).map(built => built.row);
    for (const row of rows) {
      if (row.efficiency_per_watt !== null) anyEfficiency = true;
      if (row.net_basis === 'recomputed_at_your_rate') anyRecomputed = true;
    }

    return {
      name: device.entry.name,
      slug: device.entry.slug,
      type: device.entry.type,
      hardware_url: hardwareUrl(device.entry.slug),
      market_price_usd: price,
      best_coin_id: device.bestCoinId,
      best_net_usd_day: usdPerDay(device.bestNet),
      profitable_coin_count: device.evaluated > 0 ? device.profitable : null,
      payback_days_at_best_coin: payback,
      // Counted over everything the device mines, not over the rows survived by
      // a coin filter: a 55-coin GPU must never read as a one-coin GPU.
      supported_coin_count: Array.isArray(device.entry.coins) ? device.entry.coins.length : rows.length,
      evaluated_coin_count: device.evaluated,
      returned_coin_count: rows.length,
      has_more_coins: (Array.isArray(device.entry.coins) ? device.entry.coins.length : rows.length) > rows.length,
      coins: rows,
    };
  });

  const top = deviceViews[0];
  const topBuild = returned[0];
  const rateLabel = `$${appliedRate}/kWh`;
  const supporters =
    matched.length === 1 ? 'this device supports' : `these ${matched.length} matching devices support`;
  const scanned = `Ranked over ${loaded.byCoin.size} of the ${orderedCoinIds.length} coin${
    orderedCoinIds.length === 1 ? '' : 's'
  } ${supporters}.`;

  let summary: string;
  if (topBuild.bestNet === null) {
    summary =
      `${matched.length} device${matched.length === 1 ? '' : 's'} match "${rawQuery}"` +
      (coinFilter ? ` and mine ${coinFilter.id}` : '') +
      `, but BackPow has no revenue figures for ${coinFilter ? 'that coin' : 'the coins they mine'} ` +
      `right now, so no ranking by profit is possible. Hashrate, power draw and market price are ` +
      `returned as measured.`;
  } else {
    const bestRow = topBuild.rows.find(r => r.row.coin_id === topBuild.bestCoinId);
    const gross = bestRow ? bestRow.row.revenue_usd_day : null;
    const power = bestRow ? bestRow.row.power_cost_usd_day : null;
    const breakdown =
      gross !== null && power !== null ? ` (${usd(gross)} gross minus ${usd(power)} of power)` : '';
    const verdict = topBuild.bestNet > 0 ? 'nets' : 'loses';
    const magnitude = usd(Math.abs(topBuild.bestNet));
    summary = coinFilter
      ? `At ${rateLabel}, the ${top.name} ${verdict} ${magnitude} per day on ${coinFilter.id}${breakdown}. ` +
        `${matched.length} device${matched.length === 1 ? ' matching' : 's matching'} "${rawQuery}" ` +
        `mine${matched.length === 1 ? 's' : ''} this coin.`
      : `At ${rateLabel}, the best coin BackPow tracks for the ${top.name} is ${topBuild.bestCoinId}: it ` +
        `${verdict} ${magnitude} per day${breakdown}. ${scanned}`;
  }

  const warnings: string[] = [];

  if (callerRate === undefined) {
    warnings.push(ELECTRICITY_NOTE);
  } else {
    warnings.push(
      `Net figures were computed at your ${rateLabel}. Gross revenue is unaffected by the tariff; ` +
        `only the power line moves, and rows already published at ${appliedRate} USD/kWh are used as-is.`
    );
  }

  if (anyEfficiency) {
    warnings.push(
      'Efficiency per watt is only meaningful between machines running the same algorithm. Across ' +
        'algorithms the numbers differ by many orders of magnitude for unit reasons alone — a Blake3 ' +
        'rate and a Cuckoo graph rate are not the same quantity — so rank by net USD per day instead.'
    );
  }

  if (devices.length > returned.length) {
    warnings.push(
      `${devices.length} devices match "${rawQuery}"; the ${returned.length} most profitable are ` +
        `returned. Raise limit (max ${MAX_DEVICE_LIMIT}) or narrow the query rather than treating this ` +
        `as the full list.`
    );
  }

  if (orderedCoinIds.length > selectedCoinIds.length || loaded.deadlineTruncated) {
    warnings.push(
      `Profitability was evaluated over ${loaded.byCoin.size} of the ${orderedCoinIds.length} coins these ` +
        `devices support` +
        (loaded.deadlineTruncated ? ' (the call budget ran out before the rest)' : '') +
        `. A coin that was not evaluated could pay more than the winner shown, so this is the best of ` +
        `what was priced, not a proof of the maximum. Pass coin_id to price one network exactly.`
    );
  }

  if (loaded.unavailable > 0) {
    warnings.push(
      `${loaded.unavailable} coin document${loaded.unavailable === 1 ? '' : 's'} could not be read ` +
        `during this call, so those coins were skipped rather than judged. That is not evidence they ` +
        `are unprofitable or untracked — retry for a complete ranking.`
    );
  }

  if (loaded.absent > 0) {
    warnings.push(
      `BackPow publishes no economics document for ${loaded.absent} of the coins these devices support, ` +
        `so those rows carry hashrate and power but no revenue.`
    );
  }

  if (!oracleKnown) {
    warnings.push(
      'The live oracle was unreachable, so per-coin algorithm labels and rate units are omitted rather ' +
        'than guessed. Hashrates are returned as raw numbers with no unit suffix.'
    );
  }

  if (anyEstimatedPrice) {
    warnings.push(
      'At least one market price here is modelled rather than observed, or rests on a single listing. ' +
        'Check the per-device price caveat before quoting a figure or a payback period.'
    );
  }

  if (anyPayback) {
    warnings.push(
      'Payback days divide the median price by today\'s net and assume both hold. Difficulty rises and ' +
        'rewards halve, so a real payback period is longer, often much longer.'
    );
  }

  if (anyRecomputed) {
    warnings.push(
      'Rows marked recomputed_at_your_rate were re-derived as revenue minus watts x 24h x your tariff, ' +
        'because BackPow published them at a different reference rate.'
    );
  }

  const data: HardwareData = {
    query: rawQuery,
    type_filter: typeFilter,
    coin_filter: coinFilter ? coinFilter.id : null,
    summary,
    ranking:
      'Devices are ordered by their best net USD per day at the stated tariff (an exactly-named model ' +
      'first), and each device\'s coins by net USD per day. Both lists are truncated from the top of ' +
      'that ordering.',
    electricity_cost_usd_kwh: appliedRate,
    electricity_cost_source: callerRate === undefined ? 'backpow_reference' : 'caller',
    returned_count: deviceViews.length,
    total_count: devices.length,
    has_more: devices.length > deviceViews.length,
    coins_considered: orderedCoinIds.length,
    coins_evaluated: loaded.byCoin.size,
    devices: deviceViews,
  };

  const subject = coinFilter
    ? `${top.name} mining economics on ${coinFilter.id}`
    : `${top.name} mining economics`;

  return envelope(
    data,
    provenance({
      asOfUtc: loaded.oldestDate ? `${loaded.oldestDate}T00:00:00Z` : null,
      ageSeconds: Math.max(indexFetched.ageSeconds, loaded.ageSeconds),
      servedFrom: worstServedFrom(indexFetched.servedFrom, loaded.servedFrom),
      dataSource: loaded.byCoin.size > 0 ? 'mixed' : 'hardware_index',
      url: coinFilter ? comboUrl(coinFilter.id, top.slug) : hardwareUrl(top.slug),
      subject,
      methodology: METHODOLOGY,
    }),
    warnings
  );
}
