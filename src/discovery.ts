/**
 * Discovery metadata manifests for autonomous AI agents, crawlers, and registries.
 *
 * Implements:
 * - A2A (Agent-to-Agent) discovery: /.well-known/agent-card.json & /.well-known/agent.json
 * - MCP Server manifest: /.well-known/mcp/server.json & /server.json
 * - Crawler directives: /robots.txt
 */

export const AGENT_CARD = {
  $schema: 'https://a2a-protocol.org/schemas/v1.0/agent-card.json',
  name: 'BackPow PoW Oracle',
  description:
    'Proof of Work oracle: solo mining odds, cost of production, live network hashrate and difficulty for 126+ PoW networks, and mining hardware efficiency.',
  version: '1.0.1',
  url: 'https://backpow.com',
  documentationUrl: 'https://backpow.com/mcp',
  openApiUrl: 'https://mcp.backpow.com/openapi.json',
  provider: {
    name: 'BackPow',
    url: 'https://backpow.com',
  },
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  supportedInterfaces: [
    {
      url: 'https://mcp.backpow.com/mcp',
      protocolBinding: 'JSONRPC',
      protocolVersion: '2025-03-26',
    },
    {
      url: 'https://mcp.backpow.com/v1',
      protocolBinding: 'HTTP+JSON',
      protocolVersion: 'OpenAPI-3.1',
    },
  ],
  defaultInputModes: ['application/json', 'text/plain'],
  defaultOutputModes: ['application/json', 'text/plain'],
  skills: [
    {
      id: 'calculate_solo_mining_odds',
      name: 'Solo Mining Odds',
      description:
        'Probability of a solo miner finding a block, computed as a Poisson process over live network difficulty and hashrate, plus electricity cost.',
      tags: ['pow', 'mining', 'crypto', 'solo-mining', 'odds', 'hashrate', 'poisson'],
      examples: [
        'What are my odds of solo mining a Bitcoin block with 100 TH/s?',
        'How long to find a block solo mining Kaspa?',
        'Calculate solo mining probability for Monero with 50 KH/s',
      ],
    },
    {
      id: 'get_cost_of_production',
      name: 'Cost of Production',
      description:
        'Calculates the electricity cost of mining 1 unit of a PoW coin using the most efficient ASIC/GPU/CPU hardware and electricity rates.',
      tags: ['pow', 'mining', 'economics', 'cost-of-production', 'profitability'],
      examples: [
        'What is the cost of production for 1 Bitcoin right now?',
        'Is mining Kaspa profitable at 0.05 USD per kWh?',
        'Compare mining cost vs market price for Ravencoin',
      ],
    },
    {
      id: 'get_coin_oracle',
      name: 'Live Network State',
      description:
        'Live network telemetry for 126+ PoW blockchains: difficulty, network hashrate, block height, block reward, block time target, and data age.',
      tags: ['pow', 'hashrate', 'difficulty', 'blockchain', 'network-stats'],
      examples: [
        'What is the current hashrate and difficulty of Bitcoin?',
        'Show live network stats for Monero',
        'What is the block reward of Kaspa?',
      ],
    },
    {
      id: 'list_pow_coins',
      name: 'Browse PoW Networks',
      description:
        'Paginated index of 126+ Proof of Work networks tracked by BackPow, with algorithm, network rate, collector status, and profitability filters.',
      tags: ['coins', 'pow', 'algorithms', 'crypto-list'],
      examples: [
        'What coins are tracked by BackPow?',
        'List all Scrypt coins',
        'Which coins use the KawPow algorithm?',
      ],
    },
    {
      id: 'get_hardware_benchmarks',
      name: 'Mining Hardware Economics',
      description:
        'Mining hardware matched to the coins it can mine, ranked by net USD per day at a given electricity rate for 770+ ASICs, GPUs, and CPUs.',
      tags: ['hardware', 'asic', 'gpu', 'cpu', 'mining-rig', 'efficiency', 'benchmarks'],
      examples: [
        'What should I mine with an RTX 4090?',
        'Best ASIC for Scrypt',
        'Is an Antminer S21 still profitable?',
      ],
    },
    {
      id: 'get_pow_news',
      name: 'PoW Mining News',
      description:
        'Recent curated news items about Proof of Work mining, network events, halvings, difficulty swings, and chain upgrades.',
      tags: ['news', 'hard-fork', 'halving', 'upgrades', 'mining-news'],
      examples: [
        'Latest news about Bitcoin mining',
        'Upcoming PoW hard forks',
        'When is the next halving for Litecoin?',
      ],
    },
  ],
};

export const SERVER_MANIFEST = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
  name: 'com.backpow/pow-mining-oracle',
  title: 'BackPow PoW Oracle',
  description: 'Proof of Work oracle: solo mining odds, cost of production, hashrate, mining hardware',
  version: '1.0.1',
  websiteUrl: 'https://backpow.com',
  repository: {
    url: 'https://github.com/BackpowCom/backpow-mcp-server',
    source: 'github',
  },
  icons: [
    {
      src: 'https://backpow.com/logo.png',
      mimeType: 'image/png',
    },
  ],
  remotes: [
    {
      type: 'streamable-http',
      url: 'https://mcp.backpow.com/mcp',
    },
  ],
  packages: [
    {
      registryType: 'npm',
      registryBaseUrl: 'https://registry.npmjs.org',
      identifier: '@backpow/mcp-server',
      version: '1.0.0',
      runtimeHint: 'npx',
      transport: {
        type: 'stdio',
      },
    },
  ],
};

export const ROBOTS_TXT = 'User-agent: *\nAllow: /\n';
