/**
 * Coin resolution.
 *
 * Both sides of a comparison are normalised, so a caller may write a coin name
 * the way it reads in prose — "bitcoin cash", "Ethereum Classic" — and still
 * land on the canonical id.
 *
 * Each tier collects every match rather than taking the first, and refuses when
 * more than one candidate survives. Tickers and name prefixes are shared by
 * several networks, so a first-match rule would answer about a different coin
 * than the caller meant, with nothing in the response to signal the swap. An
 * explicit ambiguity error lets the caller pick.
 */

import { OracleClient } from '../services/oracleClient.js';
import { SiteDataClient } from '../services/siteDataClient.js';
import { Deadline } from '../services/http.js';
import { OracleCoin } from '../types.js';
import { ambiguousCoin, unknownCoin } from '../errors.js';

export type ResolvedVia = 'exact_id' | 'exact_ticker' | 'prefix' | 'substring';

export interface ResolvedCoin {
  id: string;
  ticker: string;
  algorithm: string;
  resolved_via: ResolvedVia;
  /** Present when the query was not an exact id, so the caller can echo it. */
  matched_query?: string;
}

/** Below this length a prefix or substring matches too many coins to carry meaning. */
const MIN_FUZZY_LENGTH = 3;

/**
 * There is deliberately no alias table. Every candidate for one — "btc",
 * "bitcoin cash", "ethereum classic", "kas" — is already reached by
 * normalisation plus the exact-id and exact-ticker tiers, and an alias that
 * shadows a genuine ambiguity resolves it silently in one direction instead of
 * reporting it. Add one only for a name no tier can reach.
 */

/** Lowercase and drop everything that is not a letter or digit. */
export function normalise(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toResolved(coin: OracleCoin, via: ResolvedVia, query?: string): ResolvedCoin {
  return {
    id: coin.coin_id,
    ticker: coin.ticker,
    algorithm: coin.algorithm,
    resolved_via: via,
    ...(via === 'exact_id' ? {} : { matched_query: query }),
  };
}

export class CoinResolver {
  constructor(
    private readonly oracleClient: OracleClient,
    private readonly siteClient: SiteDataClient
  ) {}

  /**
   * Resolve a caller-supplied coin reference to a canonical id.
   *
   * Throws `ambiguous_coin` (with the candidate list) or `unknown_coin` (with
   * did-you-mean suggestions) rather than ever returning a guess. Callers must
   * not fall back to the raw query string on failure: a resolved id is a known
   * member of the catalogue, while the raw query is unvalidated caller input
   * and downstream code interpolates the id into request paths.
   */
  async resolve(query: string, deadline?: Deadline): Promise<ResolvedCoin> {
    if (typeof query !== 'string' || query.trim() === '') {
      throw unknownCoin(String(query ?? ''));
    }

    const clean = normalise(query);
    if (!clean) throw unknownCoin(query);

    const coins = (await this.oracleClient.getAllCoins(deadline)).data;

    // Tier 1 — exact canonical id. "bitcoin cash" normalises into this tier,
    // and an exact id always wins over a prefix that would be ambiguous.
    const byId = coins.filter(c => normalise(c.coin_id) === clean);
    if (byId.length === 1) return toResolved(byId[0], 'exact_id');
    if (byId.length > 1) throw ambiguousCoin(query, byId.map(c => c.coin_id));

    // Tier 2 — exact ticker. A ticker carried by several coin ids is reported
    // as ambiguous, since nothing in the query distinguishes them.
    const byTicker = coins.filter(c => normalise(c.ticker) === clean);
    if (byTicker.length === 1) return toResolved(byTicker[0], 'exact_ticker', query);
    if (byTicker.length > 1) throw ambiguousCoin(query, byTicker.map(c => c.coin_id));

    // Tiers 3 and 4 — prefix then substring. Both are skipped for queries
    // shorter than MIN_FUZZY_LENGTH, which would match a large share of the
    // catalogue and say nothing about which coin was meant.
    if (clean.length >= MIN_FUZZY_LENGTH) {
      const byPrefix = coins.filter(c => normalise(c.coin_id).startsWith(clean));
      if (byPrefix.length === 1) return toResolved(byPrefix[0], 'prefix', query);
      if (byPrefix.length > 1) throw ambiguousCoin(query, byPrefix.map(c => c.coin_id));

      const bySubstring = coins.filter(c => normalise(c.coin_id).includes(clean));
      if (bySubstring.length === 1) return toResolved(bySubstring[0], 'substring', query);
      if (bySubstring.length > 1) throw ambiguousCoin(query, bySubstring.map(c => c.coin_id));
    }

    throw unknownCoin(query, this.suggest(clean, coins));
  }

  /**
   * Resolve without throwing on failure. Used where a miss is a normal outcome
   * (news filtering) rather than an error.
   */
  async tryResolve(query: string, deadline?: Deadline): Promise<ResolvedCoin | null> {
    try {
      return await this.resolve(query, deadline);
    } catch {
      return null;
    }
  }

  /** Cheap did-you-mean: shared prefix first, then shared characters. */
  private suggest(clean: string, coins: OracleCoin[]): string[] {
    const scored = coins
      .map(c => {
        const id = normalise(c.coin_id);
        let score = 0;
        const head = clean.slice(0, 3);
        if (head && id.startsWith(head)) score += 10;
        if (id.includes(clean.slice(0, 4))) score += 5;
        if (normalise(c.ticker).startsWith(clean.slice(0, 2))) score += 3;
        return { id: c.coin_id, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => s.id);
    return scored;
  }
}
