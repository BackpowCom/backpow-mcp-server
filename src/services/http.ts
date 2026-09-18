/**
 * Shared fetch plumbing: bounded caches, an edge-cache hint, a per-call
 * deadline, and a staleness contract.
 *
 * Three properties the rest of the server depends on:
 *  - caches are bounded, because their keys derive from caller-supplied ids;
 *  - a cached value returned after an upstream failure is labelled
 *    `stale_cache` and is only served inside a bounded staleness window, so an
 *    isolate that loses its origin stops answering rather than serving an old
 *    snapshot as current;
 *  - a genuine 404 stays distinguishable from a transport failure, so "this
 *    coin has no data" and "the origin is unreachable" never collapse into the
 *    same answer.
 */

import { ServedFrom } from '../attribution.js';
import { upstreamUnavailable } from '../errors.js';

export interface Fetched<T> {
  data: T;
  servedFrom: ServedFrom;
  /** Age of the cached copy in seconds; 0 when freshly fetched. */
  ageSeconds: number;
}

interface CacheEntry<T> {
  data: T;
  storedAt: number;
}

/**
 * Insertion-ordered map with a hard size cap.
 *
 * The cap is load-bearing rather than tidiness: cache keys derive from
 * caller-supplied coin ids, so an unbounded Map would grow with request traffic
 * inside an isolate with a fixed memory ceiling.
 */
export class BoundedCache<T> {
  private map = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries = 256) {}

  get(key: string): CacheEntry<T> | undefined {
    const hit = this.map.get(key);
    if (hit) {
      // Refresh recency so the cap evicts the least-recently-used entry.
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, data: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { data, storedAt: Date.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

/** Fresh window, and the outer bound past which stale data is refused outright. */
export const DEFAULT_TTL_MS = 60_000;
export const MAX_STALE_MS = 15 * 60_000;

/**
 * Whole-call budget, shared by every upstream fetch a call makes. A tool call
 * that chains several fetches costs at most this in total, not this per fetch.
 */
export const CALL_BUDGET_MS = 6_000;
const PER_FETCH_CAP_MS = 2_500;

export class Deadline {
  private readonly expiresAt: number;

  constructor(budgetMs: number = CALL_BUDGET_MS) {
    this.expiresAt = Date.now() + budgetMs;
  }

  remaining(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  /** Timeout for the next fetch: whatever is left, capped. */
  sliceMs(): number {
    return Math.max(250, Math.min(this.remaining(), PER_FETCH_CAP_MS));
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }
}

export interface FetchJsonOptions {
  /** Seconds the Cloudflare edge should hold the response. */
  edgeTtlSeconds?: number;
  deadline?: Deadline;
}

/**
 * Fetch and parse JSON. Returns null on 404 (a genuine not-found) and throws on
 * anything else, so callers can tell the two apart.
 */
export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T | null> {
  const deadline = options.deadline ?? new Deadline();
  if (deadline.expired()) {
    throw new Error(`deadline exceeded before fetching ${url}`);
  }

  const init: RequestInit & { cf?: Record<string, unknown> } = {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(deadline.sliceMs()),
  };
  if (options.edgeTtlSeconds) {
    // Applies a cache policy to this subrequest only. The origin keeps serving
    // browsers whatever headers it chooses; this decides how long the edge may
    // hold the copy the Worker itself reads.
    init.cf = { cacheTtl: options.edgeTtlSeconds, cacheEverything: true };
  }

  const resp = await fetch(url, init);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`upstream responded ${resp.status}`);
  return (await resp.json()) as T;
}

/**
 * Read-through cache with an explicit staleness contract.
 *
 * On a fresh hit the cached value is returned as `cache`. On an upstream
 * failure a cached value is returned as `stale_cache` — but only within
 * MAX_STALE_MS; past that the failure surfaces instead. Mining economics move
 * continuously, so a figure that old no longer describes current conditions and
 * is withheld rather than presented as current.
 */
export async function cached<T>(
  cache: BoundedCache<T>,
  key: string,
  subject: string,
  loader: () => Promise<T | null>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<Fetched<T> | null> {
  const hit = cache.get(key);
  const now = Date.now();

  if (hit && now - hit.storedAt < ttlMs) {
    return { data: hit.data, servedFrom: 'cache', ageSeconds: Math.floor((now - hit.storedAt) / 1000) };
  }

  try {
    const loaded = await loader();
    if (loaded === null) return null;
    cache.set(key, loaded);
    return { data: loaded, servedFrom: 'live', ageSeconds: 0 };
  } catch (err) {
    if (hit && now - hit.storedAt < MAX_STALE_MS) {
      return {
        data: hit.data,
        servedFrom: 'stale_cache',
        ageSeconds: Math.floor((now - hit.storedAt) / 1000),
      };
    }
    throw upstreamUnavailable(subject);
  }
}

/**
 * Coin ids reach URL paths, so they are checked against this shape before a
 * path is built. The pattern admits only characters that carry no meaning to a
 * path resolver, which keeps a caller-supplied id confined to the single
 * directory it is interpolated into.
 */
export const COIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafePathSegment(value: string): boolean {
  return typeof value === 'string' && COIN_ID_PATTERN.test(value);
}
