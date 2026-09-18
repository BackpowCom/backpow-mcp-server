/**
 * Tool definitions and dispatch.
 *
 * These descriptions are the only thing a model reads about the server before
 * choosing a tool, so each one states what the tool returns, when it applies,
 * and which sibling covers the adjacent question. Three of the tools take
 * `coin_id` and nothing else distinguishes them at the schema level, so the
 * prose has to carry that distinction.
 *
 * Two constraints from published directory review criteria shape the wording:
 * descriptions must not promote a product, and must not instruct the assistant
 * how to behave (that reads as a prompt-injection pattern). They therefore
 * describe capability and applicability only. Attribution belongs in the
 * response payload instead.
 */

import * as z from 'zod/mini';

import { ToolDeps } from './deps.js';
import { invalidArguments } from '../errors.js';
import { ADVERTISED_UNITS } from '../math/poisson.js';
import { handleSoloOdds } from './soloOdds.js';
import { handleCostOfProduction } from './cop.js';
import { handleCoinOracle } from './oracle.js';
import { handleListCoins } from './coins.js';
import { handleHardware } from './hardware.js';
import { handleNews } from './news.js';

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  annotations: ToolAnnotations;
}

/**
 * Every tool here reads public data and changes nothing. Declaring that lets a
 * host auto-approve calls rather than prompting on each invocation.
 */
const READ_ONLY: Omit<ToolAnnotations, 'title'> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const COIN_ID_PROPERTY = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$',
  description:
    'Coin name or ticker, e.g. "Bitcoin", "BTC", "Kaspa", "bitcoin cash", "Monero". Ambiguous ' +
    'input is rejected with the list of matching networks rather than resolved to a guess, ' +
    'because several tickers are shared by more than one tracked chain (DGB, XVG and TARI ' +
    'among them).',
};

const ELECTRICITY_PROPERTY = {
  type: 'number',
  minimum: 0,
  maximum: 2,
  description:
    'Electricity price in USD per kWh. Defaults to 0.069, an industrial hosting tariff; ' +
    'residential rates are commonly 3-5x higher and change profitability conclusions.',
};

export const BACKPOW_TOOLS: ToolDefinition[] = [
  {
    name: 'calculate_solo_mining_odds',
    title: 'Solo mining odds',
    description:
      'Probability of a solo miner finding a block, computed as a Poisson process over live network ' +
      'difficulty and hashrate, plus the electricity cost of the attempt. Returns mean time to a block, ' +
      'the chance of at least one block over 1/7/30/90/365 days, and lucky-vs-unlucky waiting times ' +
      '(5th, 50th and 95th percentile) — variance dominates at small hashrates, so the average alone is ' +
      'misleading. Use for questions like "how long would it take to solo mine a Bitcoin block with 100 TH/s", ' +
      '"what are my odds solo mining Kaspa", or "is solo mining worth it with this rig". ' +
      'For pooled mining economics or whether a coin is profitable at all, use get_cost_of_production. ' +
      'For raw network state without a miner, use get_coin_oracle.',
    inputSchema: {
      type: 'object',
      properties: {
        coin_id: COIN_ID_PROPERTY,
        hashrate: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'The miner\'s rate, as a number. The unit goes in hashrate_unit.',
        },
        hashrate_unit: {
          type: 'string',
          enum: ADVERTISED_UNITS,
          description:
            'Unit for hashrate. Most networks measure in hashes per second (H/s…EH/s). Cuckoo-family ' +
            'chains measure graphs per second (gps) and Aleo measures proofs per second — an unrecognised ' +
            'unit is rejected rather than assumed, because assuming H/s can be wrong by a factor of 10^12.',
        },
        power_watts: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: 1e9,
          description: 'Miner power draw in watts, e.g. 3500 for an ASIC or 320 for a GPU. Optional.',
        },
        electricity_cost_usd_kwh: ELECTRICITY_PROPERTY,
      },
      required: ['coin_id', 'hashrate', 'hashrate_unit'],
      additionalProperties: false,
    },
    annotations: { title: 'Solo mining odds', ...READ_ONLY },
  },
  {
    name: 'get_cost_of_production',
    title: 'Cost of production',
    description:
      'Cost of Production (CoP) for one Proof of Work coin: the all-in electricity cost of mining one ' +
      'unit on the most efficient hardware BackPow tracks for that algorithm, compared against spot price. ' +
      'Returns CoP in USD, spot, gross margin, whether miners are currently above or below water, the ' +
      'reference machine and tariff behind the figure, and a 30-day trend including whether the reference ' +
      'machine changed (which indicates the efficiency frontier moved). Accepts a custom electricity rate. ' +
      'Use for "is mining X profitable", "what does it cost to produce one Monero", "are miners underwater", ' +
      'or "break-even electricity price". For a specific rig rather than a coin, use get_hardware_benchmarks. ' +
      'For block-finding probability, use calculate_solo_mining_odds.',
    inputSchema: {
      type: 'object',
      properties: {
        coin_id: COIN_ID_PROPERTY,
        electricity_cost_usd_kwh: ELECTRICITY_PROPERTY,
      },
      required: ['coin_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Cost of production', ...READ_ONLY },
  },
  {
    name: 'get_coin_oracle',
    title: 'Live network state',
    description:
      'Current network state for one Proof of Work chain, measured by BackPow\'s stratum collector nodes: ' +
      'difficulty, derived network hashrate, block height, block reward, protocol block-time target versus ' +
      'the latest observed interval, and the source pool. Every response carries a confidence block — how ' +
      'many independent pool operators agreed, whether the reward figure is live or a static fallback, and ' +
      'how old the observation is. Networks whose collectors are stalled or unreachable return an error ' +
      'rather than zeros. Use for "what is Kaspa\'s current difficulty", "network hashrate of Monero", ' +
      '"current block reward". For economics use get_cost_of_production; for mining probability use ' +
      'calculate_solo_mining_odds.',
    inputSchema: {
      type: 'object',
      properties: { coin_id: COIN_ID_PROPERTY },
      required: ['coin_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Live network state', ...READ_ONLY },
  },
  {
    name: 'list_pow_coins',
    title: 'Browse PoW networks',
    description:
      'Paginated index of the Proof of Work networks BackPow tracks, with algorithm, network rate, ' +
      'collector status and canonical page URL. Optionally filtered by algorithm or restricted to coins ' +
      'currently mining above cost. Returns the distinct algorithm list so valid filter values are ' +
      'discoverable. Use to find which networks exist for an algorithm, to browse the catalogue, or to ' +
      'resolve an ambiguous coin reference. Results are paginated: request a larger limit or a later ' +
      'offset rather than expecting the full catalogue in one response.',
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: {
          type: 'string',
          maxLength: 64,
          description:
            'Case-insensitive substring filter on algorithm, e.g. "SHA-256", "Scrypt", "KawPow", ' +
            '"RandomX", "Autolykos". The response lists every algorithm present.',
        },
        profitable_only: {
          type: 'boolean',
          description:
            'Restrict to coins whose spot price currently exceeds Cost of Production. Profitability is ' +
            'resolved for the returned page only, and the response reports how many of those coins have ' +
            'CoP coverage, so a small result set can be distinguished from missing data.',
        },
        sort_by: {
          type: 'string',
          enum: ['name', 'network_rate', 'suffering'],
          description:
            'Ordering. "suffering" ranks by how far Cost of Production exceeds spot price. Defaults to name.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Rows to return, 1-100. Defaults to 25.',
        },
        offset: { type: 'integer', minimum: 0, description: 'Rows to skip for pagination. Defaults to 0.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Browse PoW networks', ...READ_ONLY },
  },
  {
    name: 'get_hardware_benchmarks',
    title: 'Mining hardware economics',
    description:
      'Mining hardware matched to the coins it can mine, ranked by net USD per day at a given electricity ' +
      'rate. Covers ASICs, GPUs and CPUs, with hashrate and power draw per coin, gross revenue, net profit, ' +
      'and market price including whether that price is an observed listing or a model estimate. ' +
      'Use for "what should I mine with an RTX 4090", "best ASIC for Scrypt", "is an Antminer S21 still ' +
      'profitable", or "how much does a Bitaxe make". Coins are ranked by profitability, not alphabetically, ' +
      'and results are capped — ask for a higher limit rather than assuming the list is complete. ' +
      'For a coin\'s economics independent of any particular rig, use get_cost_of_production.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 2,
          maxLength: 64,
          description:
            'Hardware model or keyword, at least 2 characters, e.g. "RTX 4090", "Antminer S21", ' +
            '"Bitaxe", "Ryzen 9 7950X". Short or generic queries match hundreds of devices, so pair them ' +
            'with type and limit.',
        },
        type: {
          type: 'string',
          enum: ['ASIC', 'GPU', 'CPU'],
          description: 'Restrict to one hardware class.',
        },
        coin_id: {
          ...COIN_ID_PROPERTY,
          description:
            'Restrict the per-device coin rows to one network, e.g. to answer "how much does this rig ' +
            'make on Kaspa". Optional.',
        },
        electricity_cost_usd_kwh: ELECTRICITY_PROPERTY,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Devices to return, 1-25. Defaults to 5.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: { title: 'Mining hardware economics', ...READ_ONLY },
  },
  {
    name: 'get_pow_news',
    title: 'PoW mining news',
    description:
      'Recent news items about Proof of Work mining and network events, optionally filtered to one coin. ' +
      'Items are aggregated from third-party feeds and are returned as quoted external content with their ' +
      'publisher and a relevance score, not as BackPow statements of fact. Use when a question turns on ' +
      'recent events — a halving, a difficulty swing, a pool outage, a chain upgrade. For numbers rather ' +
      'than narrative, use get_coin_oracle or get_cost_of_production.',
    inputSchema: {
      type: 'object',
      properties: {
        coin_id: { ...COIN_ID_PROPERTY, description: 'Optional coin filter, e.g. "Bitcoin", "Zcash", "Kaspa".' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Items to return, 1-20. Defaults to 5.',
        },
        include_low_signal: {
          type: 'boolean',
          description:
            'Include items that relevance triage scored 0. Excluded by default so results stay on ' +
            'topic for Proof of Work mining.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'PoW mining news', ...READ_ONLY },
  },
];

/**
 * Runtime argument validation.
 *
 * `inputSchema` above is advertised to clients, but a client is free to send
 * anything, so the same constraints are enforced here before a handler runs.
 * Type checks matter as much as range checks: a non-numeric `hashrate` would
 * otherwise flow into the arithmetic as `NaN`, and comparisons against `NaN`
 * are false, so every downstream guard would pass and the response would be
 * well-formed but empty of meaning.
 *
 * The schemas are strict objects so an unsupported argument is a visible error
 * rather than a silent no-op. Sibling tools take overlapping keys — for
 * instance `electricity_cost_usd_kwh` — and a caller that sends one to a tool
 * which does not model it should be told, not handed the default answer.
 */
const coinId = z
  .string('coin_id must be a string, e.g. "Bitcoin" or "BTC"')
  .check(
    z.minLength(1, 'coin_id cannot be empty'),
    z.maxLength(64, 'coin_id is too long to be a coin name or ticker'),
    z.regex(
      /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/,
      'coin_id must be a coin name or ticker such as "Bitcoin", "BTC" or "bitcoin cash"'
    )
  );

const electricity = z.optional(
  z
    .number('electricity_cost_usd_kwh must be a number in USD per kWh')
    .check(
      z.gte(0, 'electricity_cost_usd_kwh cannot be negative'),
      z.lte(2, 'electricity_cost_usd_kwh above 2 USD/kWh is not a plausible tariff')
    )
);

const limitBetween = (max: number) =>
  z.optional(
    z
      .int('limit must be a whole number')
      .check(z.gte(1, 'limit must be at least 1'), z.lte(max, `limit cannot exceed ${max}`))
  );

const ARG_SCHEMAS = {
  calculate_solo_mining_odds: z.strictObject({
    coin_id: coinId,
    hashrate: z
      .number('hashrate must be a number; put the unit in hashrate_unit')
      .check(
        z.positive('hashrate must be greater than zero'),
        z.lte(1e24, 'hashrate is implausibly large')
      ),
    hashrate_unit: z
      .string('hashrate_unit must be a string, e.g. "TH/s"')
      .check(z.minLength(1, 'hashrate_unit is required'), z.maxLength(32, 'hashrate_unit is too long')),
    power_watts: z.optional(
      z
        .number('power_watts must be a number')
        .check(z.positive('power_watts must be greater than zero'), z.lte(1e9, 'power_watts is implausibly large'))
    ),
    electricity_cost_usd_kwh: electricity,
  }),
  get_cost_of_production: z.strictObject({
    coin_id: coinId,
    electricity_cost_usd_kwh: electricity,
  }),
  get_coin_oracle: z.strictObject({ coin_id: coinId }),
  list_pow_coins: z.strictObject({
    algorithm: z.optional(
      z.string('algorithm must be a string').check(z.maxLength(64, 'algorithm filter is too long'))
    ),
    profitable_only: z.optional(z.boolean('profitable_only must be true or false')),
    sort_by: z.optional(
      z.enum(['name', 'network_rate', 'suffering'], 'sort_by must be name, network_rate or suffering')
    ),
    limit: limitBetween(100),
    offset: z.optional(
      z.int('offset must be a whole number').check(z.gte(0, 'offset cannot be negative'), z.lte(10_000, 'offset is too large'))
    ),
  }),
  get_hardware_benchmarks: z.strictObject({
    query: z
      .string('query must be a string, e.g. "RTX 4090"')
      .check(
        z.minLength(2, 'query must be at least 2 characters — a single letter matches almost every device'),
        z.maxLength(64, 'query is too long')
      ),
    type: z.optional(z.enum(['ASIC', 'GPU', 'CPU'], 'type must be ASIC, GPU or CPU')),
    coin_id: z.optional(coinId),
    electricity_cost_usd_kwh: electricity,
    limit: limitBetween(25),
  }),
  get_pow_news: z.strictObject({
    coin_id: z.optional(coinId),
    limit: limitBetween(20),
    include_low_signal: z.optional(z.boolean('include_low_signal must be true or false')),
  }),
} as const;

export type ToolName = keyof typeof ARG_SCHEMAS;

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(ARG_SCHEMAS, name);
}

function validate<N extends ToolName>(name: N, args: unknown): z.infer<(typeof ARG_SCHEMAS)[N]> {
  const parsed = ARG_SCHEMAS[name].safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw invalidArguments(
      `Invalid arguments for ${name}: ` +
        issues.map(i => `${i.path} — ${i.message}`).join('; '),
      { issues }
    );
  }
  return parsed.data as z.infer<(typeof ARG_SCHEMAS)[N]>;
}

/** Validates then dispatches. Unknown tool names are the caller's error to handle. */
export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  deps: ToolDeps
): Promise<unknown> {
  if (!isToolName(name)) {
    throw invalidArguments(`Unknown tool "${name}".`, {
      available_tools: BACKPOW_TOOLS.map(t => t.name),
    });
  }

  switch (name) {
    case 'calculate_solo_mining_odds':
      return handleSoloOdds(validate('calculate_solo_mining_odds', rawArgs), deps);
    case 'get_cost_of_production':
      return handleCostOfProduction(validate('get_cost_of_production', rawArgs), deps);
    case 'get_coin_oracle':
      return handleCoinOracle(validate('get_coin_oracle', rawArgs), deps);
    case 'list_pow_coins':
      return handleListCoins(validate('list_pow_coins', rawArgs), deps);
    case 'get_hardware_benchmarks':
      return handleHardware(validate('get_hardware_benchmarks', rawArgs), deps);
    case 'get_pow_news':
      return handleNews(validate('get_pow_news', rawArgs), deps);
  }
}
