/**
 * Shared dependency bundle handed to every tool handler.
 *
 * One `Deadline` is created per tool call and threaded through every upstream
 * fetch it makes, so the budget is whole-call rather than per fetch: a handler
 * that chains several reads shares CALL_BUDGET_MS across all of them instead of
 * multiplying a per-fetch timeout by the length of the chain.
 */

import { OracleClient } from '../services/oracleClient.js';
import { SiteDataClient } from '../services/siteDataClient.js';
import { CoinResolver } from '../data/resolver.js';
import { Deadline } from '../services/http.js';

export interface ToolDeps {
  oracle: OracleClient;
  site: SiteDataClient;
  resolver: CoinResolver;
  deadline: Deadline;
}

/** Reference electricity tariff used across BackPow when the caller gives none. */
export const DEFAULT_ELECTRICITY_USD_KWH = 0.069;

export const ELECTRICITY_NOTE =
  `Unless stated otherwise, figures assume ${DEFAULT_ELECTRICITY_USD_KWH} USD/kWh — an industrial ` +
  `hosting tariff. Residential rates are commonly 3-5x higher, which changes profitability conclusions.`;
