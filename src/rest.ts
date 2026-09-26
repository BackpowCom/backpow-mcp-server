/**
 * REST API router that forwards HTTP requests to BackPow tools.
 * Exposes clean REST endpoints documented by OpenAPI 3.1.
 */

import { runTool } from './server.js';
import { ToolDeps } from './tools/deps.js';

export interface RestHandlerResult {
  status: number;
  body: unknown;
}

function parseNumber(val: string | null | undefined): number | undefined {
  if (val === null || val === undefined || val === '') return undefined;
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

function parseBoolean(val: string | null | undefined): boolean | undefined {
  if (val === null || val === undefined || val === '') return undefined;
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  return undefined;
}

export async function handleRestRequest(
  pathname: string,
  searchParams: URLSearchParams,
  bodyData: Record<string, unknown> | null,
  deps: Omit<ToolDeps, 'deadline'>
): Promise<RestHandlerResult | null> {
  const getParam = (name: string): any => {
    if (bodyData && bodyData[name] !== undefined) return bodyData[name];
    return searchParams.get(name);
  };

  let toolName: string;
  let args: Record<string, unknown>;

  switch (pathname) {
    case '/v1/solo-mining-odds':
    case '/v1/solo-odds': {
      toolName = 'calculate_solo_mining_odds';
      args = {
        coin_id: getParam('coin_id'),
        hashrate: typeof getParam('hashrate') === 'number' ? getParam('hashrate') : parseNumber(getParam('hashrate')),
        hashrate_unit: getParam('hashrate_unit'),
      };
      const watts = typeof getParam('power_watts') === 'number' ? getParam('power_watts') : parseNumber(getParam('power_watts'));
      if (watts !== undefined) args.power_watts = watts;
      const elec = typeof getParam('electricity_cost_usd_kwh') === 'number' ? getParam('electricity_cost_usd_kwh') : parseNumber(getParam('electricity_cost_usd_kwh'));
      if (elec !== undefined) args.electricity_cost_usd_kwh = elec;
      break;
    }

    case '/v1/cost-of-production':
    case '/v1/cop': {
      toolName = 'get_cost_of_production';
      args = {
        coin_id: getParam('coin_id'),
      };
      const elec = typeof getParam('electricity_cost_usd_kwh') === 'number' ? getParam('electricity_cost_usd_kwh') : parseNumber(getParam('electricity_cost_usd_kwh'));
      if (elec !== undefined) args.electricity_cost_usd_kwh = elec;
      break;
    }

    case '/v1/coin-oracle':
    case '/v1/oracle': {
      toolName = 'get_coin_oracle';
      args = {
        coin_id: getParam('coin_id'),
      };
      break;
    }

    case '/v1/coins': {
      toolName = 'list_pow_coins';
      args = {};
      const algo = getParam('algorithm');
      if (algo) args.algorithm = algo;
      const prof = typeof getParam('profitable_only') === 'boolean' ? getParam('profitable_only') : parseBoolean(getParam('profitable_only'));
      if (prof !== undefined) args.profitable_only = prof;
      const sort = getParam('sort_by');
      if (sort) args.sort_by = sort;
      const limit = typeof getParam('limit') === 'number' ? getParam('limit') : parseNumber(getParam('limit'));
      if (limit !== undefined) args.limit = limit;
      const offset = typeof getParam('offset') === 'number' ? getParam('offset') : parseNumber(getParam('offset'));
      if (offset !== undefined) args.offset = offset;
      break;
    }

    case '/v1/hardware': {
      toolName = 'get_hardware_benchmarks';
      args = {
        query: getParam('query'),
      };
      const type = getParam('type');
      if (type) args.type = type;
      const coinId = getParam('coin_id');
      if (coinId) args.coin_id = coinId;
      const elec = typeof getParam('electricity_cost_usd_kwh') === 'number' ? getParam('electricity_cost_usd_kwh') : parseNumber(getParam('electricity_cost_usd_kwh'));
      if (elec !== undefined) args.electricity_cost_usd_kwh = elec;
      const limit = typeof getParam('limit') === 'number' ? getParam('limit') : parseNumber(getParam('limit'));
      if (limit !== undefined) args.limit = limit;
      break;
    }

    case '/v1/news': {
      toolName = 'get_pow_news';
      args = {};
      const coinId = getParam('coin_id');
      if (coinId) args.coin_id = coinId;
      const limit = typeof getParam('limit') === 'number' ? getParam('limit') : parseNumber(getParam('limit'));
      if (limit !== undefined) args.limit = limit;
      const lowSignal = typeof getParam('include_low_signal') === 'boolean' ? getParam('include_low_signal') : parseBoolean(getParam('include_low_signal'));
      if (lowSignal !== undefined) args.include_low_signal = lowSignal;
      break;
    }

    default:
      return null;
  }

  try {
    const result = await runTool(toolName, args, deps);
    if (result.isError) {
      return {
        status: 400,
        body: result.structuredContent || { error: 'tool_error', details: result.content },
      };
    }
    return {
      status: 200,
      body: result.structuredContent || result.content,
    };
  } catch (err: any) {
    return {
      status: err.code === 'invalid_arguments' ? 400 : 500,
      body: { error: err.code || 'internal_error', message: err.message },
    };
  }
}
