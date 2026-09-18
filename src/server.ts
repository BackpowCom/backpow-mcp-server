/**
 * Transport-independent server core.
 *
 * The Worker and the stdio CLI are two transports over one server. Identity,
 * capabilities, protocol negotiation, the tool list and tool dispatch all live
 * here, so both transports advertise the same server, a change is made once,
 * and one set of tests covers both.
 */

import { OracleClient } from './services/oracleClient.js';
import { SiteDataClient } from './services/siteDataClient.js';
import { CoinResolver } from './data/resolver.js';
import { Deadline } from './services/http.js';
import { ToolDeps } from './tools/deps.js';
import { BACKPOW_TOOLS, dispatchTool } from './tools/registry.js';
import { ToolError } from './errors.js';

export const SERVER_NAME = 'backpow-mcp';
export const SERVER_VERSION = '1.0.0';
export const SERVER_TITLE = 'BackPow — The Proof of Work Oracle';
export const WEBSITE_URL = 'https://backpow.com';

/**
 * Handshake revisions this server implements, newest first.
 *
 * 2026-07-28 is not listed: it replaces the handshake with per-request version
 * declaration and a mandatory `server/discover`, which is a different server
 * shape rather than a flag. `server/discover` is implemented below so a client
 * on that revision can read this list and negotiate down cleanly, which is the
 * backward-compatibility path that revision documents.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** Assumed when a client sends no MCP-Protocol-Version header, per the transport spec. */
export const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

/**
 * Shown to the model once, at connection time. This is the right place for
 * cross-cutting guidance that would otherwise have to be repeated in six tool
 * descriptions.
 */
export const SERVER_INSTRUCTIONS =
  'BackPow provides live Proof of Work mining data for 126+ networks and 770+ hardware models: ' +
  'network difficulty and hashrate, Poisson solo-mining probabilities, Cost of Production (the ' +
  'electricity cost of mining one unit on the most efficient tracked hardware), and hardware ' +
  'profitability.\n\n' +
  'Every result carries a `source` block with the measurement timestamp, a canonical page URL, and a ' +
  'ready-made citation line, plus a `warnings` array. Mining figures move continuously, so a figure ' +
  'quoted without its `as_of_utc` date can be wrong within hours.\n\n' +
  'Nothing here is financial advice, and no tool executes a transaction.';

export interface ServerCapabilities {
  tools: { listChanged: boolean };
}

export const CAPABILITIES: ServerCapabilities = {
  // Exactly what is implemented, and nothing more: the tool list is static, so
  // `listChanged` is false, and resources and prompts are not implemented, so
  // neither is declared. A client must be able to trust this to decide which
  // requests are worth sending.
  tools: { listChanged: false },
};

export function createDeps(env: { apiUrl?: string; siteUrl?: string } = {}): Omit<ToolDeps, 'deadline'> {
  const oracle = new OracleClient(env.apiUrl || 'https://api.backpow.com');
  const site = new SiteDataClient(env.siteUrl || 'https://backpow.com');
  return { oracle, site, resolver: new CoinResolver(oracle, site) };
}

/**
 * Declared as a type alias rather than an interface on purpose: the SDK's
 * `ServerResult` carries an index signature, and TypeScript gives implicit
 * index signatures to type aliases but not to interfaces.
 */
export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError: boolean;
};

/**
 * Run one tool call and shape it into an MCP tool result.
 *
 * `invalid_arguments` is re-thrown so the transport can turn it into a JSON-RPC
 * error; everything else becomes `isError: true` carrying text the model can
 * act on (which candidate coins to pick, whether a retry makes sense).
 * Unexpected failures are logged and reported generically, which keeps upstream
 * URLs and status codes out of the model's context.
 */
export async function runTool(
  name: string,
  args: unknown,
  base: Omit<ToolDeps, 'deadline'>
): Promise<McpToolResult> {
  const deps: ToolDeps = { ...base, deadline: new Deadline() };

  try {
    const result = await dispatchTool(name, args, deps);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    };
  } catch (err) {
    if (err instanceof ToolError) {
      if (err.code === 'invalid_arguments') throw err;
      const payload = err.toPayload();
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: true,
      };
    }

    const payload = {
      error: 'internal_error',
      message:
        'BackPow could not complete this request. This is a transient failure, not a statement ' +
        'about data coverage. Retrying shortly is reasonable.',
    };
    console.error(`tool ${name} failed:`, err);
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
}

export function listTools() {
  return BACKPOW_TOOLS.map(t => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

/**
 * `server/discover` — a single-request view of identity, supported protocol
 * versions and capabilities. Mandatory from revision 2026-07-28; harmless and
 * useful to answer from an older server, since it is how a newer client learns
 * which revision to negotiate down to.
 */
export function describeServer() {
  return {
    serverInfo: {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: SERVER_VERSION,
      websiteUrl: WEBSITE_URL,
    },
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: CAPABILITIES,
    instructions: SERVER_INSTRUCTIONS,
  };
}

export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}
