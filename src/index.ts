/**
 * Cloudflare Worker entrypoint — MCP over Streamable HTTP.
 *
 * `/mcp` is the single MCP endpoint, speaking the Streamable HTTP transport
 * defined by the current spec revisions. The server is stateless: it mints no
 * session ids and holds no state between requests, so each POST is a
 * self-contained batch of JSON-RPC messages answered in the HTTP response body.
 * That is what makes it a good fit for a Worker, where requests are not
 * guaranteed to reach the same isolate.
 */

import {
  CAPABILITIES,
  DEFAULT_PROTOCOL_VERSION,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  WEBSITE_URL,
  createDeps,
  describeServer,
  listTools,
  negotiateProtocolVersion,
  runTool,
} from './server.js';
import { ToolError } from './errors.js';

interface Env {
  BACKPOW_API_URL?: string;
  BACKPOW_SITE_URL?: string;
  /** Comma-separated extra origins permitted to call the endpoint from a browser. */
  BACKPOW_EXTRA_ORIGINS?: string;
}

const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Origins allowed to drive the endpoint from a browser.
 *
 * The transport spec makes Origin validation a MUST. A request with no Origin
 * header — every non-browser client, which is essentially all of them — is
 * allowed through; a request carrying an unrecognised Origin is refused, so an
 * unrelated page cannot drive the endpoint from a visitor's browser.
 */
const DEFAULT_ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  'https://claude.com',
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://cursor.com',
  'https://www.cursor.com',
  'https://vscode.dev',
  'https://insiders.vscode.dev',
  'https://backpow.com',
  'https://www.backpow.com',
  'https://mcp.backpow.com',
  'https://smithery.ai',
  'https://glama.ai',
  'https://modelcontextprotocol.io',
  'https://inspector.modelcontextprotocol.io',
]);

function allowedOrigins(env: Env): Set<string> {
  if (!env.BACKPOW_EXTRA_ORIGINS) return DEFAULT_ALLOWED_ORIGINS;
  const extra = env.BACKPOW_EXTRA_ORIGINS.split(',')
    .map(o => o.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra]);
}

/**
 * Loopback origins are always allowed.
 *
 * The MCP Inspector, and every locally-hosted client, sends an origin like
 * `http://localhost:6274`, so these are the origins a connection is inspected
 * and debugged from. DNS rebinding is an attack *against* a server bound to
 * loopback; it is not a reason for a public server to refuse loopback callers.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function originAllowed(origin: string, env: Env): boolean {
  return isLoopbackOrigin(origin) || allowedOrigins(env).has(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Accept',
    'Access-Control-Expose-Headers': 'MCP-Protocol-Version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...extra },
  });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0' as const,
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/** A JSON-RPC message with no `id` is a notification: it gets 202 and no body. */
function isNotification(msg: any): boolean {
  return !msg || typeof msg !== 'object' || msg.id === undefined || msg.id === null;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const rawOrigin = request.headers.get('Origin');

    // Only a present-and-unrecognised Origin is refused. A request with no
    // Origin — every non-browser client, which is nearly all of them — passes
    // through untouched, so this cannot break the server-side fetches that
    // hosted connectors use.
    if (rawOrigin && !originAllowed(rawOrigin, env)) {
      return new Response(
        JSON.stringify({
          error: 'origin_not_allowed',
          message:
            `This endpoint does not accept browser requests from ${rawOrigin}. Non-browser ` +
            'clients send no Origin header and are unaffected. To have an origin added, ' +
            'open an issue at https://backpow.com/mcp.',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const origin = rawOrigin;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Human/monitoring surface. Not an MCP endpoint — MCP traffic is /mcp only.
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(
        {
          name: SERVER_TITLE,
          server: SERVER_NAME,
          version: SERVER_VERSION,
          status: 'ok',
          mcp_endpoint: `${url.origin}${MCP_PATH}`,
          transport: 'streamable-http',
          protocol_versions: [...SUPPORTED_PROTOCOL_VERSIONS],
          tools: listTools().length,
          docs: `${WEBSITE_URL}/mcp`,
        },
        200,
        origin
      );
    }

    // Paths of the deprecated HTTP+SSE transport. 410 with the replacement
    // endpoint tells a client still configured for it exactly what to change;
    // a bare 404 would leave it guessing.
    if (url.pathname === '/sse' || url.pathname === '/message') {
      return json(
        {
          error: 'transport_removed',
          message:
            'The HTTP+SSE transport has been removed. Use Streamable HTTP at ' +
            `${url.origin}${MCP_PATH}.`,
          mcp_endpoint: `${url.origin}${MCP_PATH}`,
        },
        410,
        origin
      );
    }

    if (url.pathname !== MCP_PATH) {
      return json({ error: 'not_found', mcp_endpoint: `${url.origin}${MCP_PATH}` }, 404, origin);
    }

    // Spec: GET on the MCP endpoint returns an SSE stream or 405. It must not
    // be 404 — a conformant client reads 404 as "session terminated" and loops
    // re-initializing. This server is stateless, so there is no stream to open.
    if (request.method === 'GET' || request.method === 'DELETE') {
      return json(
        {
          error: 'method_not_allowed',
          message:
            'This server is stateless: it does not open a standalone SSE stream and holds no ' +
            'sessions. POST JSON-RPC messages to this endpoint.',
        },
        405,
        origin,
        { Allow: 'POST, OPTIONS' }
      );
    }

    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, origin, { Allow: 'POST, OPTIONS' });
    }

    const protocolVersion = request.headers.get('MCP-Protocol-Version');
    if (protocolVersion && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
      return json(
        {
          error: 'unsupported_protocol_version',
          supported: [...SUPPORTED_PROTOCOL_VERSIONS],
          requested: protocolVersion,
        },
        400,
        origin
      );
    }

    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      // Requiring a JSON content type also keeps the endpoint out of reach of
      // CORS simple requests: `text/plain` would let a cross-origin page POST
      // here without a preflight, and so without Origin validation.
      return json({ error: 'unsupported_media_type', expected: 'application/json' }, 415, origin);
    }

    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return json({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES }, 413, origin);
    }

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return json(rpcError(null, -32700, 'Parse error: request body could not be read'), 400, origin);
    }
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: 'payload_too_large', max_bytes: MAX_BODY_BYTES }, 413, origin);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch (err: any) {
      // -32700 is reported from this try alone, which covers nothing but
      // JSON.parse. Widening it over dispatch and serialisation would report an
      // internal fault as a syntax error in the caller's own body, and a client
      // told that will retry the identical bytes.
      return json(
        rpcError(null, -32700, `Parse error: ${err?.message || 'invalid JSON'}`),
        400,
        origin
      );
    }

    const deps = createDeps({ apiUrl: env.BACKPOW_API_URL, siteUrl: env.BACKPOW_SITE_URL });
    const negotiatedHeader = {
      'MCP-Protocol-Version': protocolVersion || DEFAULT_PROTOCOL_VERSION,
    };

    const messages = Array.isArray(body) ? body : [body];
    if (messages.length === 0) {
      return json(rpcError(null, -32600, 'Invalid Request: empty batch'), 400, origin);
    }

    const responses: unknown[] = [];
    for (const message of messages) {
      const response = await handleMessage(message, deps);
      if (response) responses.push(response);
    }

    // Spec: input consisting only of notifications or responses gets 202 with
    // no body. A JSON-RPC response object is not an alternative here — every
    // response must carry the `id` of a request, and there is none to answer.
    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: { ...corsHeaders(origin), ...negotiatedHeader } });
    }

    const payload = Array.isArray(body) ? responses : responses[0];
    return json(payload, 200, origin, negotiatedHeader);
  },
};

async function handleMessage(
  message: any,
  deps: ReturnType<typeof createDeps>
): Promise<unknown | null> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request: each message must be a JSON-RPC object');
  }
  if (message.jsonrpc !== '2.0') {
    return rpcError(message.id, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  }

  const { id, method, params } = message;

  if (isNotification(message)) return null;
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request: method must be a string');
  }

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: CAPABILITIES,
          serverInfo: {
            name: SERVER_NAME,
            title: SERVER_TITLE,
            version: SERVER_VERSION,
            websiteUrl: WEBSITE_URL,
          },
          instructions: SERVER_INSTRUCTIONS,
        },
      };

    case 'server/discover':
      return { jsonrpc: '2.0', id, result: describeServer() };

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: listTools() } };

    case 'tools/call': {
      const name = params?.name;
      if (typeof name !== 'string' || !name) {
        return rpcError(id, -32602, 'Missing tool name in params.name');
      }
      try {
        const result = await runTool(name, params?.arguments ?? {}, deps);
        return { jsonrpc: '2.0', id, result };
      } catch (err) {
        // Only argument validation reaches here; runTool turns every other
        // failure into an isError result the model can read and recover from.
        if (err instanceof ToolError) {
          return rpcError(id, -32602, err.message, err.data);
        }
        return rpcError(id, -32603, 'Internal error');
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`, {
        supported_methods: [
          'initialize',
          'server/discover',
          'ping',
          'tools/list',
          'tools/call',
        ],
      });
  }
}
