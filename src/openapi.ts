/**
 * OpenAPI 3.1.0 specification for BackPow PoW Oracle.
 * Compatible with OpenAI GPT Actions, LangChain, LlamaIndex, and REST agents.
 */

export const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'BackPow PoW Oracle API',
    description:
      'The Proof of Work Oracle: live solo mining Poisson odds, cost of production (CoP), network hashrate and difficulty for 126+ PoW networks, mining hardware benchmarks for 770+ models, and curated PoW news.',
    version: '1.0.1',
    contact: {
      name: 'BackPow Support',
      url: 'https://backpow.com',
    },
  },
  servers: [
    {
      url: 'https://mcp.backpow.com',
      description: 'Production BackPow Oracle API',
    },
  ],
  paths: {
    '/v1/solo-mining-odds': {
      get: {
        operationId: 'calculateSoloMiningOdds',
        summary: 'Calculate solo mining odds',
        description:
          'Probability of a solo miner finding a block, computed as a Poisson process over live network difficulty and hashrate, plus the electricity cost of the attempt.',
        parameters: [
          {
            name: 'coin_id',
            in: 'query',
            required: true,
            description: 'Coin name or ticker, e.g. "Bitcoin", "BTC", "Kaspa", "Monero"',
            schema: { type: 'string' },
          },
          {
            name: 'hashrate',
            in: 'query',
            required: true,
            description: 'Miner hashrate as a positive number (e.g. 200, 1500)',
            schema: { type: 'number' },
          },
          {
            name: 'hashrate_unit',
            in: 'query',
            required: true,
            description: 'Hashrate unit, e.g. "H/s", "KH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s", "Sol/s", "gps"',
            schema: { type: 'string' },
          },
          {
            name: 'power_watts',
            in: 'query',
            required: false,
            description: 'Miner power consumption in Watts, e.g. 3500 for ASIC or 300 for GPU',
            schema: { type: 'number' },
          },
          {
            name: 'electricity_cost_usd_kwh',
            in: 'query',
            required: false,
            description: 'Electricity tariff in USD per kWh (defaults to 0.069 reference rate)',
            schema: { type: 'number' },
          },
        ],
        responses: {
          '200': {
            description: 'Poisson probabilities, time-to-block, and variance estimates',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          '400': { description: 'Invalid arguments or unresolvable coin' },
        },
      },
    },
    '/v1/cost-of-production': {
      get: {
        operationId: 'getCostOfProduction',
        summary: 'Cost of Production (CoP) for a PoW coin',
        description:
          'The all-in electricity cost of mining one coin unit on the most efficient hardware tracked for that algorithm, compared against spot price and gross margin.',
        parameters: [
          {
            name: 'coin_id',
            in: 'query',
            required: true,
            description: 'Coin name or ticker, e.g. "Bitcoin", "BTC", "Kaspa", "Monero"',
            schema: { type: 'string' },
          },
          {
            name: 'electricity_cost_usd_kwh',
            in: 'query',
            required: false,
            description: 'Custom electricity tariff in USD per kWh',
            schema: { type: 'number' },
          },
        ],
        responses: {
          '200': {
            description: 'Cost of production in USD, spot price, gross margin %, and profitability verdict',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          '400': { description: 'Invalid arguments or unresolvable coin' },
        },
      },
    },
    '/v1/coin-oracle': {
      get: {
        operationId: 'getCoinOracle',
        summary: 'Live network telemetry and difficulty',
        description:
          'Current network state for one PoW chain measured by BackPow stratum collector nodes: difficulty, hashrate, block height, reward, and block time target.',
        parameters: [
          {
            name: 'coin_id',
            in: 'query',
            required: true,
            description: 'Coin name or ticker, e.g. "Bitcoin", "BTC", "Kaspa", "Monero"',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Live stratum telemetry, block time target, and pool agreement count',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          '400': { description: 'Invalid arguments or unresolvable coin' },
        },
      },
    },
    '/v1/coins': {
      get: {
        operationId: 'listPowCoins',
        summary: 'Browse and filter tracked PoW coins',
        description:
          'Paginated index of the 126+ Proof of Work networks BackPow tracks, with algorithm, network rate, and profitability status.',
        parameters: [
          {
            name: 'algorithm',
            in: 'query',
            required: false,
            description: 'Case-insensitive filter by algorithm, e.g. "SHA-256", "Scrypt", "RandomX"',
            schema: { type: 'string' },
          },
          {
            name: 'profitable_only',
            in: 'query',
            required: false,
            description: 'Restrict to coins whose spot price currently exceeds Cost of Production',
            schema: { type: 'boolean' },
          },
          {
            name: 'sort_by',
            in: 'query',
            required: false,
            description: 'Sort ordering: "name", "network_rate", or "suffering"',
            schema: { type: 'string', enum: ['name', 'network_rate', 'suffering'] },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Rows to return (1-100, default 25)',
            schema: { type: 'integer' },
          },
          {
            name: 'offset',
            in: 'query',
            required: false,
            description: 'Rows to skip for pagination (default 0)',
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': {
            description: 'List of PoW coins and distinct algorithms',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
    '/v1/hardware': {
      get: {
        operationId: 'getHardwareBenchmarks',
        summary: 'Search mining hardware benchmarks and economics',
        description:
          'Mining hardware (ASICs, GPUs, CPUs) matched to coins they can mine, ranked by net USD per day at a given electricity rate.',
        parameters: [
          {
            name: 'query',
            in: 'query',
            required: true,
            description: 'Hardware model or keyword, e.g. "RTX 4090", "Antminer S21", "Bitaxe"',
            schema: { type: 'string' },
          },
          {
            name: 'type',
            in: 'query',
            required: false,
            description: 'Restrict to hardware class: ASIC, GPU, or CPU',
            schema: { type: 'string', enum: ['ASIC', 'GPU', 'CPU'] },
          },
          {
            name: 'coin_id',
            in: 'query',
            required: false,
            description: 'Restrict per-device coin rows to one network, e.g. "Kaspa"',
            schema: { type: 'string' },
          },
          {
            name: 'electricity_cost_usd_kwh',
            in: 'query',
            required: false,
            description: 'Electricity tariff in USD per kWh',
            schema: { type: 'number' },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Devices to return (1-25, default 5)',
            schema: { type: 'integer' },
          },
        ],
        responses: {
          '200': {
            description: 'Matching hardware devices with hashrate, power draw, and revenue breakdown',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          '400': { description: 'Invalid query parameter' },
        },
      },
    },
    '/v1/news': {
      get: {
        operationId: 'getPowNews',
        summary: 'Curated PoW mining news and alerts',
        description:
          'Recent curated news items about Proof of Work mining, halvings, difficulty swings, and hard forks with injection protection.',
        parameters: [
          {
            name: 'coin_id',
            in: 'query',
            required: false,
            description: 'Optional coin filter, e.g. "Bitcoin", "Kaspa"',
            schema: { type: 'string' },
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'Items to return (1-20, default 5)',
            schema: { type: 'integer' },
          },
          {
            name: 'include_low_signal',
            in: 'query',
            required: false,
            description: 'Include items scored 0 by relevance triage (default false)',
            schema: { type: 'boolean' },
          },
        ],
        responses: {
          '200': {
            description: 'Curated news articles with source attribution',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
        },
      },
    },
  },
};
