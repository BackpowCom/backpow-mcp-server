/**
 * Upstream payload shapes and tool result types.
 *
 * Field names in the site documents are the upstream spelling (spaces, dots)
 * and are quoted as such; result types use snake_case.
 */

export interface OracleCoin {
  schema_version: number;
  coin_id: string;
  ticker: string;
  algorithm: string;
  family: string;
  height: number | null;
  difficulty: number;
  network_hashrate: number;
  block_time_target: number;
  block_time: number | null;
  block_reward: number | null;
  /**
   * 'live' | 'static_fallback' | 'unknown'. Only 'live' means the reward was
   * read from an observed coinbase; the other values mark a schedule-derived
   * or unknown reward, and any revenue figure inherits that uncertainty.
   */
  reward_status: string;
  status: 'confirmed' | 'conflict' | 'single_source' | 'stalled' | 'unavailable';
  observed_at: number;
  source_pool: string;
  /** 'hashes_per_second' | 'graphs_per_second' | 'proofs_per_second' */
  rate_unit: string;
  distinct_operators: number;
  agreement_count: number;
  formula_coherence: number | null;
  integration_ready: boolean;
  integration_blockers: string[];
}

export interface BotDataCoin {
  rank: number;
  name: string;
  ticker: string;
  sufferingRating: string;
  algorithm: string;
  costRatio: number;
  cop: number;
  spot: number;
}

/** A hardware entry inside a per-coin detail document. */
export interface CoinHardwareItem {
  name: string;
  hashrate: number;
  watts: number;
  /** USD/day gross, precomputed upstream at the reference tariff. */
  revenue: number;
  /** USD/day net of power at the reference tariff (`copElecRate`). */
  profitability: number;
}

export interface CoinHistoryPoint {
  date: string;
  cop: number | null;
  usdPrice: number;
  copRatio: number | null;
  copMiner: string | null;
  copHwType: string | null;
  nethash: number;
  difficulty: number;
}

export interface CoinDetailData {
  Algorithm: string;
  'Block time': number;
  'Last block': number;
  'Bl. reward': number;
  Difficulty: string | number;
  Nethash: number;
  Nethash_raw?: number;
  'Ex. rate'?: string;
  /** NOTE: denominated in BTC, not USD, per the upstream convention. */
  'Ex. volume 24h'?: number;
  'Daily emission'?: number;
  'Market cap'?: number;
  usdPrice: number;
  usdPriceSource?: string;
  cop: number | null;
  copMiner: string | null;
  copHwType: string | null;
  copElecRate: number;
  halvingTimestamp?: number | null;
  ASICS: CoinHardwareItem[];
  GPUS: CoinHardwareItem[];
  CPUS: CoinHardwareItem[];
  history30d?: CoinHistoryPoint[];
}

export interface HardwarePrice {
  condition: string;
  currency: string;
  min: number;
  max: number;
  median: number;
  avg?: number;
  /**
   * Number of observed listings the figures summarise. A count of 1 makes
   * `min`, `max` and `median` the same single listing rather than a range.
   */
  count: number;
  /** True when the price is modelled rather than taken from observed listings. */
  estimated: boolean;
}

export interface HardwareIndexCoin {
  coinId: string;
  hashrate: number;
  watts: number;
}

export interface HardwareIndexEntry {
  name: string;
  slug: string;
  type: 'ASIC' | 'GPU' | 'CPU' | string;
  coins: HardwareIndexCoin[];
  price: HardwarePrice | null;
}

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  virality: number;
  publishedAt: number;
}
