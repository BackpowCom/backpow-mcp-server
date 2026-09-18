/**
 * Provenance and attribution.
 *
 * Every successful tool result carries where the number came from, when it was
 * measured, and the canonical BackPow page to cite. Mining figures move
 * continuously, so a figure quoted without its measurement date cannot be
 * qualified by the reader, and one quoted without a source cannot be checked.
 *
 * The four canonical page shapes:
 *   /{CoinId}                 coin pages
 *   /hardware/{slug}          hardware pages
 *   /{CoinId}/{slug}          coin x hardware combination pages
 *   /solo-pools/{CoinId}      solo pool pages
 */

export const SITE_BASE = 'https://backpow.com';

export type ServedFrom = 'live' | 'cache' | 'stale_cache' | 'bundled_snapshot';

export interface Provenance {
  /** When the underlying measurement was taken (not when this call ran). */
  as_of_utc: string | null;
  /** Age of the measurement in seconds, or null when the source carries no clock. */
  data_age_seconds: number | null;
  /** Whether this call reached the origin or was answered from a cached copy. */
  served_from: ServedFrom;
  /** Which BackPow subsystem produced the numbers. */
  data_source: 'stratum_oracle' | 'site_snapshot' | 'hardware_index' | 'news_feed' | 'mixed';
  /** Canonical human page for this subject. */
  url: string;
  /** Ready-made citation line; models copy these verbatim. */
  cite_as: string;
  methodology: string;
}

export function coinUrl(coinId: string): string {
  return `${SITE_BASE}/${encodeURIComponent(coinId)}`;
}

export function hardwareUrl(slug: string): string {
  return `${SITE_BASE}/hardware/${encodeURIComponent(slug)}`;
}

export function comboUrl(coinId: string, slug: string): string {
  return `${SITE_BASE}/${encodeURIComponent(coinId)}/${encodeURIComponent(slug)}`;
}

export function soloPoolsUrl(coinId: string): string {
  return `${SITE_BASE}/solo-pools/${encodeURIComponent(coinId)}`;
}

function isoDay(iso: string | null): string {
  if (!iso) return 'undated';
  return iso.slice(0, 10);
}

export interface ProvenanceInput {
  asOfUtc?: string | null;
  ageSeconds?: number | null;
  servedFrom?: ServedFrom;
  dataSource?: Provenance['data_source'];
  url: string;
  subject: string;
  methodology: string;
}

export function provenance(input: ProvenanceInput): Provenance {
  const asOf = input.asOfUtc ?? null;
  return {
    as_of_utc: asOf,
    data_age_seconds: input.ageSeconds ?? null,
    served_from: input.servedFrom ?? 'live',
    data_source: input.dataSource ?? 'stratum_oracle',
    url: input.url,
    cite_as: `BackPow — The Proof of Work Oracle, "${input.subject}", retrieved ${isoDay(asOf)} — ${input.url}`,
    methodology: input.methodology,
  };
}

/**
 * The envelope every successful tool result is wrapped in.
 *
 * `warnings` is deliberately a top-level array of plain prose: models reproduce
 * top-level string arrays far more reliably than nested caveats, and these
 * strings carry the conditions under which a figure holds — the tariff it
 * assumes, the coverage of the underlying document, how recently it was
 * measured. A caveat that is not repeated is one the reader never sees.
 */
export interface Enveloped<T> {
  warnings: string[];
  source: Provenance;
  data: T;
}

export function envelope<T>(data: T, source: Provenance, warnings: string[] = []): Enveloped<T> {
  return { warnings, source, data };
}

/** Seconds between an epoch-seconds observation and now, clamped at zero. */
export function ageFromEpochSeconds(observedAt: number | null | undefined): number | null {
  if (!observedAt || !Number.isFinite(observedAt)) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - observedAt);
}

export function isoFromEpochSeconds(observedAt: number | null | undefined): string | null {
  if (!observedAt || !Number.isFinite(observedAt)) return null;
  return new Date(observedAt * 1000).toISOString();
}
