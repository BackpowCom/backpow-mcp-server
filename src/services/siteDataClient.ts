/**
 * Client for the BackPow static site endpoints (backpow.com).
 *
 * Every figure this client serves is fetched at request time. No copy of the
 * hardware or coin documents is bundled as a fallback: a build-time snapshot
 * carries no staleness marker and would be indistinguishable from a live
 * reading, so an index that cannot be fetched surfaces as an error instead.
 * Keeping the documents out of the bundle also keeps cold starts cheap.
 */

import { BotDataCoin, CoinDetailData, HardwareIndexEntry } from '../types.js';
import {
  BoundedCache,
  Deadline,
  Fetched,
  cached,
  fetchJson,
  isSafePathSegment,
} from './http.js';

/**
 * Edge hold per document, set explicitly on each subrequest and scaled to how
 * often that document is recomputed: hardware specs change slowly, per-coin
 * economics faster.
 */
const BOT_DATA_EDGE_TTL_S = 300;
const HARDWARE_EDGE_TTL_S = 3600;
const COIN_DETAIL_EDGE_TTL_S = 900;

export class SiteDataClient {
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly botData = new BoundedCache<BotDataCoin[]>(1);
  private readonly hardware = new BoundedCache<HardwareIndexEntry[]>(1);
  private readonly coinDetail = new BoundedCache<CoinDetailData>(256);

  constructor(baseUrl: string = 'https://backpow.com', ttlMs: number = 60_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.ttlMs = ttlMs;
  }

  async getBotData(deadline?: Deadline): Promise<Fetched<BotDataCoin[]>> {
    const result = await cached(
      this.botData,
      'all',
      'the mining suffering index',
      async () => {
        const data = await fetchJson<BotDataCoin[]>(`${this.baseUrl}/bot_data.json`, {
          edgeTtlSeconds: BOT_DATA_EDGE_TTL_S,
          deadline,
        });
        return Array.isArray(data) ? data : [];
      },
      this.ttlMs
    );
    return result ?? { data: [], servedFrom: 'live', ageSeconds: 0 };
  }

  /**
   * Per-coin detail document.
   *
   * `canonicalCoinId` must already be a resolved id. It is checked against the
   * safe-segment shape and percent-encoded before it is interpolated, so the
   * path it builds can only address a document inside /coins-data/.
   */
  async getCoinDetail(
    canonicalCoinId: string,
    deadline?: Deadline
  ): Promise<Fetched<CoinDetailData> | null> {
    if (!isSafePathSegment(canonicalCoinId)) return null;

    return cached(
      this.coinDetail,
      canonicalCoinId.toLowerCase(),
      `detail data for ${canonicalCoinId}`,
      async () => {
        const data = await fetchJson<CoinDetailData>(
          `${this.baseUrl}/coins-data/${encodeURIComponent(canonicalCoinId)}.json`,
          { edgeTtlSeconds: COIN_DETAIL_EDGE_TTL_S, deadline }
        );
        // The cast to CoinDetailData is unchecked at runtime, and any JSON —
        // an array included — would satisfy it. Accept only a plain object
        // carrying at least one of the fields this type is defined by.
        if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
        if (!('Algorithm' in data) && !('usdPrice' in data) && !('Nethash' in data)) return null;
        return data;
      },
      this.ttlMs
    );
  }

  async getHardwareIndex(deadline?: Deadline): Promise<Fetched<HardwareIndexEntry[]>> {
    const result = await cached(
      this.hardware,
      'all',
      'the mining hardware index',
      async () => {
        const data = await fetchJson<HardwareIndexEntry[]>(`${this.baseUrl}/hardwareIndex.json`, {
          edgeTtlSeconds: HARDWARE_EDGE_TTL_S,
          deadline,
        });
        if (!Array.isArray(data)) throw new Error('unexpected hardwareIndex.json payload shape');
        return data;
      },
      this.ttlMs
    );
    if (!result) throw new Error('hardwareIndex.json returned 404');
    return result;
  }
}
