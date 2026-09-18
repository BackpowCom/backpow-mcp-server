/**
 * Tool: list_pow_coins
 *
 * A paginated index of the tracked PoW networks. Five rules govern the shape of
 * this surface:
 *
 *  - profitability is read from the per-coin economics documents, the same
 *    source get_cost_of_production reads. The suffering index is a ranking of
 *    coins mining below cost, not a coin table: every row in it has cop > spot
 *    by construction, so it can answer "how far below cost" but never "is this
 *    coin profitable".
 *  - the compact row carries no economics unless this call actually read an
 *    economics document for that coin. Filling the field from a source that
 *    covers a fraction of the catalogue would make absence look like a
 *    measurement; a caller who wants the figures asks get_cost_of_production.
 *  - the catalogue is paginated, sorted and projected. The full corpus in one
 *    response is tens of thousands of tokens of context for a question that is
 *    usually about a handful of networks.
 *  - upstream failures are not caught on this path. A zero count must mean a
 *    genuinely empty filtered set, never an outage rendered as an empty
 *    catalogue.
 *  - the rate formatter follows each coin's own unit family, since hashes,
 *    Cuckoo graphs and Aleo proofs are different quantities.
 */

import {
  Enveloped,
  coinUrl,
  envelope,
  isoFromEpochSeconds,
  provenance,
  ServedFrom,
} from '../attribution.js';
import { normalise } from '../data/resolver.js';
import { ToolError, upstreamUnavailable } from '../errors.js';
import { BotDataCoin, CoinDetailData, OracleCoin } from '../types.js';
import { familyFromRateUnit, formatRate, RateFamily } from '../math/poisson.js';
import { ToolDeps } from './deps.js';

export interface ListCoinsArgs {
  algorithm?: string;
  profitable_only?: boolean;
  sort_by?: 'name' | 'network_rate' | 'suffering';
  limit?: number;
  offset?: number;
}

export interface CoinRate {
  /** Base units per second, or null when the oracle reports no positive rate. */
  value: number | null;
  /**
   * What the network measures. Hashes, Cuckoo graphs and Aleo proofs are not
   * the same quantity, so the family travels with the number; get_coin_oracle
   * carries the oracle's full unit spelling for a single coin.
   */
  family: RateFamily;
  formatted: string | null;
}

export interface CoinEconomics {
  spot_price_usd: number | null;
  cop_usd: number | null;
  cop_as_pct_of_spot: number | null;
  is_profitable: boolean | null;
  /** Day the CoP belongs to; the economics documents are daily snapshots. */
  cop_as_of_date: string | null;
  /**
   * Which document the pair came from. The per-coin details cover far more of
   * the catalogue than the suffering index, which only ranks coins mining
   * below cost.
   */
  source: 'coin_detail' | 'suffering_index';
}

export interface PowCoinRow {
  coin_id: string;
  ticker: string;
  algorithm: string;
  network_rate: CoinRate;
  /** Collector consensus state: confirmed | conflict | single_source | stalled | unavailable. */
  status: OracleCoin['status'];
  url: string;
  /** Resolved only where this call actually read an economics document; null otherwise. */
  economics: CoinEconomics | null;
}

export interface ListCoinsCoverage {
  /** Coins on this page whose economics document was actually read. */
  examined: number;
  /** Of those, how many yielded both a Cost of Production and a spot price. */
  with_cop: number;
  without_cop: number;
  /** `not_requested` means no economics were resolved, so the two counts above are not a coverage claim. */
  resolved_for: 'current_page' | 'not_requested';
}

export interface ListCoinsData {
  /** Coins matching the algorithm filter — the pagination universe, not the profitable count. */
  total_count: number;
  returned_count: number;
  offset: number;
  has_more: boolean;
  coverage: ListCoinsCoverage;
  available_algorithms: string[];
  coins: PowCoinRow[];
}

const DEFAULT_LIMIT = 25;
/** Detail documents are one subrequest each, so the profitability pass gets a tighter page. */
const PROFITABILITY_PAGE_CAP = 25;
const DETAIL_CONCURRENCY = 6;
/** Below this there is no point starting another fetch; the slice would abort mid-flight. */
const DEADLINE_FLOOR_MS = 400;
const ALGORITHM_LIST_CAP = 100;

const METHODOLOGY =
  'One row per network BackPow runs a stratum collector on; the rate is derived from observed ' +
  'difficulty and the chain block-time target. Where profitability is requested it compares each ' +
  "coin's published Cost of Production against its spot price, resolved for the returned page only.";

/** The less fresh of two reads wins, so provenance never overstates freshness. */
const FRESHNESS_ORDER: ServedFrom[] = ['live', 'cache', 'stale_cache', 'bundled_snapshot'];

function worstServedFrom(a: ServedFrom, b: ServedFrom): ServedFrom {
  return FRESHNESS_ORDER.indexOf(a) >= FRESHNESS_ORDER.indexOf(b) ? a : b;
}

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

function buildRow(coin: OracleCoin, economics: CoinEconomics | null): PowCoinRow {
  const rate = positiveOrNull(coin.network_hashrate);
  const family: RateFamily = familyFromRateUnit(coin.rate_unit);
  return {
    coin_id: coin.coin_id,
    ticker: coin.ticker,
    algorithm: coin.algorithm,
    network_rate: {
      value: rate,
      family,
      formatted: rate === null ? null : formatRate(rate, family),
    },
    status: coin.status,
    url: coinUrl(coin.coin_id),
    economics,
  };
}

/**
 * Same reading rule as get_cost_of_production: today's CoP when the document
 * carries one, otherwise the most recent day in the 30-day window that does.
 * The two tools must not disagree about whether a coin is above cost.
 */
function readEconomics(detail: CoinDetailData): CoinEconomics | null {
  const history = Array.isArray(detail.history30d) ? detail.history30d : [];
  let cop = positiveOrNull(detail.cop);
  let date = history.length ? history[history.length - 1].date : null;

  if (cop === null) {
    for (let i = history.length - 1; i >= 0; i--) {
      const past = positiveOrNull(history[i].cop);
      if (past !== null) {
        cop = past;
        date = history[i].date;
        break;
      }
    }
  }

  const spot = positiveOrNull(detail.usdPrice);
  // "Above cost" is a comparison between two figures, so it is only answerable
  // when both are present: a CoP with no price, or a price with no CoP, yields
  // no economics rather than a half-populated record.
  if (cop === null || spot === null) return null;

  return {
    spot_price_usd: sig(spot),
    cop_usd: sig(cop),
    cop_as_pct_of_spot: pct((cop / spot) * 100),
    is_profitable: spot > cop,
    cop_as_of_date: date,
    source: 'coin_detail',
  };
}

function economicsFromBotRow(row: BotDataCoin): CoinEconomics | null {
  const cop = positiveOrNull(row.cop);
  const spot = positiveOrNull(row.spot);
  if (cop === null || spot === null) return null;
  return {
    spot_price_usd: sig(spot),
    cop_usd: sig(cop),
    cop_as_pct_of_spot: pct((cop / spot) * 100),
    is_profitable: spot > cop,
    cop_as_of_date: null,
    source: 'suffering_index',
  };
}

interface DetailPass {
  economics: Map<string, CoinEconomics>;
  examined: number;
  withCop: number;
  withoutCop: number;
  failures: number;
  firstError: unknown;
  deadlineCutShort: boolean;
}

/**
 * Read the economics documents for one page, a few at a time.
 *
 * Bounded rather than a single `Promise.all` over the page: each coin is one
 * subrequest, and the shared deadline has to be able to stop the pass rather
 * than have 25 flights abort together at the end of the budget.
 */
async function resolvePageEconomics(coins: OracleCoin[], deps: ToolDeps): Promise<DetailPass> {
  const pass: DetailPass = {
    economics: new Map(),
    examined: 0,
    withCop: 0,
    withoutCop: 0,
    failures: 0,
    firstError: null,
    deadlineCutShort: false,
  };

  for (let i = 0; i < coins.length; i += DETAIL_CONCURRENCY) {
    if (deps.deadline.remaining() < DEADLINE_FLOOR_MS) {
      pass.deadlineCutShort = true;
      break;
    }

    const batch = coins.slice(i, i + DETAIL_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(c => deps.site.getCoinDetail(c.coin_id, deps.deadline))
    );

    settled.forEach((outcome, idx) => {
      const coin = batch[idx];
      if (outcome.status === 'rejected') {
        pass.failures++;
        if (pass.firstError === null) pass.firstError = outcome.reason;
        return;
      }
      pass.examined++;
      // A 404 is a coverage gap (no economics document for this network yet),
      // which is a different fact from the fetch having failed.
      const economics = outcome.value ? readEconomics(outcome.value.data) : null;
      if (economics) {
        pass.economics.set(coin.coin_id, economics);
        pass.withCop++;
      } else {
        pass.withoutCop++;
      }
    });
  }

  return pass;
}

export async function handleListCoins(
  args: ListCoinsArgs,
  deps: ToolDeps
): Promise<Enveloped<ListCoinsData>> {
  const sortBy = args.sort_by ?? 'name';
  const offset = args.offset ?? 0;
  const requestedLimit = args.limit ?? DEFAULT_LIMIT;
  const pageLimit = args.profitable_only
    ? Math.min(requestedLimit, PROFITABILITY_PAGE_CAP)
    : requestedLimit;

  const warnings: string[] = [];

  // Deliberately uncaught: an outage must surface as upstream_unavailable,
  // never as an empty catalogue.
  const oracleFetched = await deps.oracle.getAllCoins(deps.deadline);
  const corpus = oracleFetched.data;

  const algorithms = Array.from(new Set(corpus.map(c => c.algorithm).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
  if (algorithms.length > ALGORITHM_LIST_CAP) {
    warnings.push(
      `available_algorithms is truncated to the first ${ALGORITHM_LIST_CAP} of ${algorithms.length} ` +
        `distinct algorithms in the catalogue.`
    );
  }

  let candidates = corpus;
  if (args.algorithm !== undefined) {
    const needle = args.algorithm.trim().toLowerCase();
    candidates = needle
      ? corpus.filter(c => (c.algorithm || '').toLowerCase().includes(needle))
      : corpus;
    if (needle && candidates.length === 0) {
      warnings.push(
        `No tracked network has an algorithm containing "${args.algorithm}". The filter is a ` +
          `case-insensitive substring match; available_algorithms lists every value present.`
      );
    }
  }

  // The suffering index is read only when it is the ranking key. It is a
  // leaderboard of coins mining below cost rather than a coin table, so it
  // answers no question the other sorts ask, and fetching it unconditionally
  // would cost a subrequest on every listing.
  let botFetchAge = 0;
  let botServedFrom: ServedFrom = 'live';
  const sufferingByCoin = new Map<string, BotDataCoin>();

  if (sortBy === 'suffering') {
    const botFetched = await deps.site.getBotData(deps.deadline);
    botFetchAge = botFetched.ageSeconds;
    botServedFrom = botFetched.servedFrom;

    const byNormalisedId = new Map(corpus.map(c => [normalise(c.coin_id), c.coin_id]));
    let unmatched = 0;
    for (const row of botFetched.data) {
      const canonical = byNormalisedId.get(normalise(row.name || ''));
      // The index names a network, while the oracle keys a multi-algorithm
      // network as one id per algorithm, so some index rows have no single
      // oracle counterpart. Choosing one of the candidates would attribute the
      // ranking to a network it was not computed for, so the row is counted
      // and dropped.
      if (!canonical) {
        unmatched++;
        continue;
      }
      sufferingByCoin.set(canonical, row);
    }

    warnings.push(
      `The suffering ranking comes from BackPow's published index, which covers ` +
        `${sufferingByCoin.size} of the ${corpus.length} tracked networks` +
        `${unmatched ? ` (${unmatched} further index row(s) match no oracle id)` : ''} and lists only ` +
        `coins mining below cost. Networks outside it are ordered by name after the ranked ones, ` +
        `not judged comfortable.`
    );
  }

  const sorted = [...candidates];
  if (sortBy === 'network_rate') {
    // Coins with no derivable rate sort last rather than as zero-rate networks.
    sorted.sort(
      (a, b) => (positiveOrNull(b.network_hashrate) ?? -1) - (positiveOrNull(a.network_hashrate) ?? -1)
    );
    const families = new Set(sorted.map(c => familyFromRateUnit(c.rate_unit)));
    if (families.size > 1) {
      warnings.push(
        `This ordering compares networks measured in different units (${[...families].join(', ')} ` +
          `families are all present). Hashes, Cuckoo graphs and Aleo proofs are not the same quantity, ` +
          `so cross-family rank is not a work comparison.`
      );
    }
  } else if (sortBy === 'suffering') {
    sorted.sort((a, b) => {
      const ra = sufferingByCoin.get(a.coin_id);
      const rb = sufferingByCoin.get(b.coin_id);
      if (ra && rb) return rb.costRatio - ra.costRatio;
      if (ra) return -1;
      if (rb) return 1;
      return a.coin_id.localeCompare(b.coin_id);
    });
  } else {
    sorted.sort((a, b) => a.coin_id.localeCompare(b.coin_id));
  }

  const totalCount = sorted.length;
  const page = sorted.slice(offset, offset + pageLimit);

  let coverage: ListCoinsCoverage = {
    examined: 0,
    with_cop: 0,
    without_cop: 0,
    resolved_for: 'not_requested',
  };

  let rows: PowCoinRow[];

  if (args.profitable_only) {
    const pass = await resolvePageEconomics(page, deps);

    // Every read failed and nothing was resolved: that is an outage, and it
    // must not be reported as "no coin on this page is profitable".
    if (pass.examined === 0 && pass.failures > 0) {
      throw pass.firstError instanceof ToolError
        ? pass.firstError
        : upstreamUnavailable('the per-coin economics documents');
    }

    coverage = {
      examined: pass.examined,
      with_cop: pass.withCop,
      without_cop: pass.withoutCop,
      resolved_for: 'current_page',
    };

    rows = page
      .filter(c => pass.economics.get(c.coin_id)?.is_profitable === true)
      .map(c => buildRow(c, pass.economics.get(c.coin_id) ?? null));

    warnings.push(
      `profitable_only is resolved for this page only: total_count (${totalCount}) counts coins matching ` +
        `the algorithm filter, ${coverage.examined} of them were checked here, ${coverage.with_cop} had ` +
        `both a Cost of Production and a spot price, and ${rows.length} of those are above cost. ` +
        `Page forward with offset to check more; it is not a catalogue-wide profitable count.`
    );

    if (coverage.without_cop > 0) {
      warnings.push(
        `${coverage.without_cop} coin(s) on this page are tracked but carry no comparable Cost of ` +
          `Production and spot price, so they are absent from the filtered rows without being ` +
          `unprofitable. A Cost of Production is published for a subset of the catalogue.`
      );
    }

    if (pass.failures > 0) {
      warnings.push(
        `${pass.failures} economics document(s) on this page could not be read on this call, so those ` +
          `coins were skipped rather than judged. Retry to include them.`
      );
    }

    if (pass.deadlineCutShort) {
      warnings.push(
        `The call budget ran out before every coin on this page was checked (${coverage.examined} of ` +
          `${page.length}). Request a smaller limit, or page forward, for complete coverage.`
      );
    }

    if (requestedLimit > PROFITABILITY_PAGE_CAP) {
      warnings.push(
        `limit was reduced from ${requestedLimit} to ${PROFITABILITY_PAGE_CAP} because profitable_only ` +
          `reads one economics document per coin. has_more reflects the reduced page.`
      );
    }
  } else {
    // On the suffering sort the index is already in hand, so the pair it ranked
    // by travels with the row at no extra cost. Every other listing leaves
    // economics null rather than reading a source that covers part of the
    // catalogue and presenting the gaps as rows without economics.
    rows = page.map(c => {
      const ranked = sufferingByCoin.get(c.coin_id);
      return buildRow(c, ranked ? economicsFromBotRow(ranked) : null);
    });
  }

  const hasMore = offset + page.length < totalCount;
  if (hasMore) {
    warnings.push(
      `This is a page, not the catalogue: ${offset + page.length} of ${totalCount} matching networks ` +
        `have been returned. Request offset ${offset + page.length} for the next page.`
    );
  }

  if (offset > 0 && page.length === 0 && totalCount > 0) {
    warnings.push(
      `offset ${offset} is past the end of the ${totalCount} matching networks, so no rows were ` +
        `returned. This is an exhausted page, not an empty catalogue.`
    );
  }

  const unconfirmed = rows.filter(r => r.status !== 'confirmed').length;
  if (unconfirmed > 0) {
    warnings.push(
      `${unconfirmed} row(s) here are not in the "confirmed" collector state; their figures are ` +
        `provisional. get_coin_oracle returns the full confidence record for one network.`
    );
  }

  const nullRate = rows.filter(r => r.network_rate.value === null).length;
  if (nullRate > 0) {
    warnings.push(
      `${nullRate} row(s) carry a null network rate: the oracle derives no positive rate for them ` +
        `right now. Null means not measured, not a network with no hashrate.`
    );
  }

  const ageSeconds = Math.max(oracleFetched.ageSeconds, botFetchAge);
  const data: ListCoinsData = {
    total_count: totalCount,
    returned_count: rows.length,
    offset,
    has_more: hasMore,
    coverage,
    available_algorithms: algorithms.slice(0, ALGORITHM_LIST_CAP),
    coins: rows,
  };

  return envelope(
    data,
    provenance({
      // The catalogue read, not a per-coin measurement: observation times differ
      // per network, and get_coin_oracle carries the exact one for a given coin.
      asOfUtc: isoFromEpochSeconds(Math.floor(Date.now() / 1000) - ageSeconds),
      ageSeconds,
      servedFrom: worstServedFrom(oracleFetched.servedFrom, botServedFrom),
      dataSource: 'mixed',
      url: 'https://backpow.com/api',
      subject: 'tracked Proof of Work networks',
      methodology: METHODOLOGY,
    }),
    warnings
  );
}
