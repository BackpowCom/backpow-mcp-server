/**
 * Client for the BackPow live oracle (api.backpow.com): stratum telemetry and
 * the curated news feed.
 */

import { OracleCoin, NewsItem } from '../types.js';
import {
  BoundedCache,
  Deadline,
  Fetched,
  cached,
  fetchJson,
  isSafePathSegment,
} from './http.js';

/**
 * Edge hold per endpoint. The coin corpus is refreshed on a short cycle, so its
 * hold stays close to the origin's own freshness window; the news feed changes
 * far more slowly and can be held for longer.
 */
const COINS_EDGE_TTL_S = 60;
const NEWS_EDGE_TTL_S = 300;

export class OracleClient {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly allCoins = new BoundedCache<OracleCoin[]>(1);
  private readonly newsAll = new BoundedCache<Record<string, NewsItem[]>>(1);
  private readonly newsByCoin = new BoundedCache<NewsItem[]>(128);

  constructor(baseUrl: string = 'https://api.backpow.com', ttlMs: number = 60_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.ttlMs = ttlMs;
  }

  /**
   * The whole coin corpus in one request. Every coin lookup goes through here
   * rather than /v1/coins/{id}: a single subrequest serves both the resolver
   * and the per-coin read, and an id that resolves to nothing never reaches the
   * network at all.
   */
  async getAllCoins(deadline?: Deadline): Promise<Fetched<OracleCoin[]>> {
    const result = await cached(
      this.allCoins,
      'all',
      'the PoW network oracle',
      async () => {
        const coins = await fetchJson<OracleCoin[]>(`${this.baseUrl}/v1/coins`, {
          edgeTtlSeconds: COINS_EDGE_TTL_S,
          deadline,
        });
        if (!Array.isArray(coins)) throw new Error('unexpected /v1/coins payload shape');
        return coins;
      },
      this.ttlMs
    );
    if (!result) throw new Error('/v1/coins returned 404');
    return result;
  }

  /** Exact-id lookup against the cached corpus. Returns null when absent. */
  async getCoin(coinId: string, deadline?: Deadline): Promise<Fetched<OracleCoin> | null> {
    const all = await this.getAllCoins(deadline);
    const key = coinId.toLowerCase();
    const found = all.data.find(c => c.coin_id.toLowerCase() === key);
    if (!found) return null;
    return { data: found, servedFrom: all.servedFrom, ageSeconds: all.ageSeconds };
  }

  async getAllNews(deadline?: Deadline): Promise<Fetched<Record<string, NewsItem[]>>> {
    const result = await cached(
      this.newsAll,
      'all',
      'the PoW news feed',
      async () => {
        const news = await fetchJson<Record<string, NewsItem[]>>(`${this.baseUrl}/v1/news`, {
          edgeTtlSeconds: NEWS_EDGE_TTL_S,
          deadline,
        });
        return news && typeof news === 'object' ? news : {};
      },
      this.ttlMs
    );
    if (!result) return { data: {}, servedFrom: 'live', ageSeconds: 0 };
    return result;
  }

  async getCoinNews(coinId: string, deadline?: Deadline): Promise<Fetched<NewsItem[]>> {
    if (!isSafePathSegment(coinId)) {
      return { data: [], servedFrom: 'live', ageSeconds: 0 };
    }
    const result = await cached(
      this.newsByCoin,
      coinId.toLowerCase(),
      `news for ${coinId}`,
      async () => {
        const items = await fetchJson<NewsItem[]>(
          `${this.baseUrl}/v1/news/${encodeURIComponent(coinId)}`,
          { edgeTtlSeconds: NEWS_EDGE_TTL_S, deadline }
        );
        return Array.isArray(items) ? items : [];
      },
      this.ttlMs
    );
    return result ?? { data: [], servedFrom: 'live', ageSeconds: 0 };
  }
}
