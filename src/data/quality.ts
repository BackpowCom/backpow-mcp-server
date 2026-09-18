/**
 * One shared data-quality gate for every coin-scoped tool.
 *
 * The oracle publishes `status`, `integration_ready`, `integration_blockers`,
 * `reward_status`, `distinct_operators` and `agreement_count` alongside the
 * numbers themselves. Every numeric answer passes through here so that the
 * refusal threshold and the caveats attached to a figure are identical
 * whichever tool the caller reached for, and so that two tools reading two
 * different documents cannot describe the same coin differently.
 */

import { OracleCoin } from '../types.js';
import { dataUnavailable } from '../errors.js';

/** Past this age the telemetry is not "live" under any reading. */
const HARD_STALE_SECONDS = 86_400;
/** Floor for the soft-warning threshold, for chains with long target times. */
const MIN_SOFT_STALE_SECONDS = 1_800;

export interface Confidence {
  status: OracleCoin['status'];
  integration_ready: boolean;
  integration_blockers: string[];
  reward_status: string;
  distinct_operators: number | null;
  agreement_count: number | null;
  observed_at_utc: string | null;
  data_age_seconds: number | null;
}

export interface Assessment {
  confidence: Confidence;
  warnings: string[];
}

function ageSeconds(coin: OracleCoin): number | null {
  if (!coin.observed_at || !Number.isFinite(coin.observed_at)) return null;
  return Math.max(0, Math.floor(Date.now() / 1000) - coin.observed_at);
}

/**
 * Collect caveats and refuse outright when the telemetry cannot support a
 * numeric answer. Throws `data_unavailable` rather than returning zeros.
 */
export function assessCoin(coin: OracleCoin, opts: { requireNumbers?: boolean } = {}): Assessment {
  const warnings: string[] = [];
  const age = ageSeconds(coin);

  const confidence: Confidence = {
    status: coin.status,
    integration_ready: Boolean(coin.integration_ready),
    integration_blockers: Array.isArray(coin.integration_blockers) ? coin.integration_blockers : [],
    reward_status: coin.reward_status || 'unknown',
    distinct_operators: Number.isFinite(coin.distinct_operators) ? coin.distinct_operators : null,
    agreement_count: Number.isFinite(coin.agreement_count) ? coin.agreement_count : null,
    observed_at_utc: coin.observed_at ? new Date(coin.observed_at * 1000).toISOString() : null,
    data_age_seconds: age,
  };

  if (coin.status === 'unavailable' || coin.status === 'stalled') {
    throw dataUnavailable(
      `Live telemetry for ${coin.coin_id}`,
      `the oracle reports this network as "${coin.status}"` +
        (age !== null ? ` and the last observation is ${Math.round(age / 3600)}h old` : '') +
        '. No figures are returned rather than stale ones presented as current.'
    );
  }

  if (age !== null && age > HARD_STALE_SECONDS) {
    throw dataUnavailable(
      `Live telemetry for ${coin.coin_id}`,
      `the most recent observation is ${Math.round(age / 3600)}h old, past the 24h freshness limit`
    );
  }

  const softStale = Math.max(MIN_SOFT_STALE_SECONDS, (coin.block_time_target || 600) * 10);
  if (age !== null && age > softStale) {
    warnings.push(
      `Telemetry for ${coin.coin_id} is ${Math.round(age / 60)} minutes old — older than usual for ` +
        `a chain targeting ${coin.block_time_target}s blocks. Treat the figures as approximate.`
    );
  }

  if (coin.status === 'conflict') {
    warnings.push(
      `Sources disagree about ${coin.coin_id}'s current state ` +
        `(status "conflict", ${confidence.agreement_count ?? '?'} of ` +
        `${confidence.distinct_operators ?? '?'} operators agreeing). Treat the figures as ` +
        `indicative until the sources converge.`
    );
  }

  if (coin.status === 'single_source') {
    warnings.push(
      `${coin.coin_id} telemetry comes from a single pool operator and is unconfirmed by a second source.`
    );
  }

  if (!coin.integration_ready) {
    const blockers = confidence.integration_blockers;
    warnings.push(
      `${coin.coin_id} is not yet marked integration-ready in the oracle` +
        (blockers.length ? ` (open issues: ${blockers.join(', ')})` : '') +
        '. Figures are provisional.'
    );
  }

  if (confidence.reward_status !== 'live') {
    warnings.push(
      `The block reward for ${coin.coin_id} is a ${confidence.reward_status} value, not derived from ` +
        `live coinbase observation. Any revenue figure inherits that uncertainty.`
    );
  }

  if (opts.requireNumbers) {
    if (!Number.isFinite(coin.network_hashrate) || coin.network_hashrate <= 0) {
      throw dataUnavailable(
        `Network hashrate for ${coin.coin_id}`,
        'the oracle currently reports no positive network rate, so mining probabilities cannot be computed'
      );
    }
  }

  return { confidence, warnings };
}

/**
 * Freshness guard for the daily-recomputed site documents.
 *
 * The oracle payload carries `observed_at`, so `assessCoin` can police its own
 * age. For the site documents the authoritative clock is the date on the last
 * row of `history30d`, which the daily recompute appends. Serving an unexpectedly old document succeeds at the transport
 * level, so the age has to be checked explicitly: mining economics are a
 * function of prices and difficulty, and a figure computed days ago no longer
 * describes current conditions.
 */
const COP_SOFT_STALE_DAYS = 2;
const COP_HARD_STALE_DAYS = 7;

export function assertDocumentFreshness(
  subject: string,
  isoDate: string | null,
  warnings: string[]
): number | null {
  if (!isoDate) {
    warnings.push(
      `${subject} carries no computation date, so its age cannot be verified. Treat it as indicative.`
    );
    return null;
  }

  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return null;

  const ageDays = Math.floor((Date.now() - parsed) / 86_400_000);
  if (ageDays > COP_HARD_STALE_DAYS) {
    throw dataUnavailable(
      subject,
      `it was last computed ${ageDays} days ago (${isoDate}), well past the daily recompute ` +
        `cadence. Mining economics that old are withheld rather than presented as current.`
    );
  }
  if (ageDays > COP_SOFT_STALE_DAYS) {
    warnings.push(
      `${subject} was last computed ${ageDays} days ago (${isoDate}), longer than the daily ` +
        `recompute cadence. Prices and difficulty move meaningfully over that span.`
    );
  }
  return ageDays;
}

export interface BlockTimeDecision {
  seconds: number;
  source: 'protocol_target' | 'observed_sample';
  target_seconds: number | null;
  observed_seconds: number | null;
  disagreement_pct: number | null;
  warning: string | null;
}

/**
 * Choose the block time that drives every solo-mining figure.
 *
 * The mean waiting time is linear in block time, so this choice scales every
 * probability and expected-time answer by the same factor. The protocol target
 * wins: it is a stable property of the chain, whereas `block_time` is a single
 * observed inter-block interval — a one-sample estimate of a highly variable
 * quantity, and not always published. The observation is kept as a cross-check
 * and surfaced as a warning when the two disagree materially, since a sustained
 * divergence means the network is running fast or slow relative to its target.
 */
export function resolveBlockTime(coin: OracleCoin): BlockTimeDecision {
  const target =
    Number.isFinite(coin.block_time_target) && coin.block_time_target > 0
      ? coin.block_time_target
      : null;
  const observed =
    coin.block_time !== null && Number.isFinite(coin.block_time) && coin.block_time > 0
      ? coin.block_time
      : null;

  if (target === null && observed === null) {
    throw dataUnavailable(
      `Block time for ${coin.coin_id}`,
      'neither a protocol target nor an observed block time is available, and a mining ' +
        'estimate cannot be built without one'
    );
  }

  if (target === null) {
    return {
      seconds: observed as number,
      source: 'observed_sample',
      target_seconds: null,
      observed_seconds: observed,
      disagreement_pct: null,
      warning:
        `No protocol block-time target is published for ${coin.coin_id}; this estimate uses a ` +
        `single observed inter-block sample (${observed}s) and carries wide uncertainty.`,
    };
  }

  let disagreement: number | null = null;
  let warning: string | null = null;
  if (observed !== null) {
    disagreement = Number((((observed - target) / target) * 100).toFixed(1));
    if (Math.abs(disagreement) > 20) {
      warning =
        `${coin.coin_id}'s most recent observed block time (${observed}s) differs from the protocol ` +
        `target (${target}s) by ${disagreement}%. This estimate uses the protocol target, which is ` +
        `the stable quantity; the network may currently be running fast or slow.`;
    }
  }

  return {
    seconds: target,
    source: 'protocol_target',
    target_seconds: target,
    observed_seconds: observed,
    disagreement_pct: disagreement,
    warning,
  };
}
