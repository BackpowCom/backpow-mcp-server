#!/usr/bin/env node
/**
 * Protocol conformance probe against a running MCP endpoint.
 *
 *   node scripts/conformance.mjs [base-url]      # default http://127.0.0.1:8787
 *
 * The unit suite covers the tool layer; this covers the HTTP layer, which it
 * structurally cannot reach: status codes, headers, JSON-RPC framing, and the
 * Origin and Content-Type checks a Streamable HTTP endpoint is required to
 * perform. Exits non-zero on the first set of failures so it can gate a
 * deployment.
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const MCP = `${BASE}/mcp`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function rpc(body, init = {}) {
  const resp = await fetch(MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(init.headers || {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* left null on purpose so callers can assert on malformed bodies */
  }
  return { status: resp.status, headers: resp.headers, text, json };
}

console.log(`\nBackPow MCP conformance — ${MCP}\n`);

console.log('transport');
{
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'conformance', version: '1' } },
  });
  check('initialize returns 200', init.status === 200, `got ${init.status}`);
  check(
    'initialize echoes the requested protocol version when supported',
    init.json?.result?.protocolVersion === '2025-06-18',
    `got ${init.json?.result?.protocolVersion}`
  );
  check('initialize advertises serverInfo.title', Boolean(init.json?.result?.serverInfo?.title));
  check('initialize ships instructions', Boolean(init.json?.result?.instructions));

  const older = await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {} },
  });
  check(
    'an older client keeps its own revision',
    older.json?.result?.protocolVersion === '2024-11-05',
    `got ${older.json?.result?.protocolVersion}`
  );

  const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('a notification gets 202', notification.status === 202, `got ${notification.status}`);
  check('a notification gets no body', notification.text === '', `got ${JSON.stringify(notification.text)}`);

  const cancelled = await rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });
  check('every notification gets 202, not just initialized', cancelled.status === 202, `got ${cancelled.status}`);

  // A client that receives 404 on the endpoint treats its session as
  // terminated and re-initialises, so an unsupported method MUST be 405 with an
  // Allow header naming the methods that are supported.
  const get = await fetch(MCP);
  check('GET on the endpoint is 405, not 404', get.status === 405, `got ${get.status}`);
  check('405 carries an Allow header', Boolean(get.headers.get('allow')));

  const del = await fetch(MCP, { method: 'DELETE' });
  check('DELETE is 405', del.status === 405, `got ${del.status}`);

  const legacy = await fetch(`${BASE}/sse`);
  check('the retired SSE path answers 410 with the current endpoint', legacy.status === 410, `got ${legacy.status}`);

  const badVersion = await rpc({ jsonrpc: '2.0', id: 3, method: 'ping' }, {
    headers: { 'MCP-Protocol-Version': '9999-99-99' },
  });
  check('an unsupported MCP-Protocol-Version is 400', badVersion.status === 400, `got ${badVersion.status}`);
}

console.log('\nsecurity');
{
  const evil = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check('an unknown Origin is refused', evil.status === 403, `got ${evil.status}`);
  check('no wildcard ACAO on a refused origin', evil.headers.get('access-control-allow-origin') !== '*');

  const inspector = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:6274' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  // Origin checking guards against DNS rebinding, so the allowlist has to be
  // narrow. The MCP Inspector runs on loopback and sends this origin, so
  // loopback stays allowed while unknown origins are refused.
  check('a loopback origin (MCP Inspector) is allowed', inspector.status === 200, `got ${inspector.status}`);

  const plain = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  check('a non-JSON content type is refused', plain.status === 415, `got ${plain.status}`);

  const huge = await rpc('x'.repeat(70_000));
  check('an oversized body is refused', huge.status === 413, `got ${huge.status}`);

  const malformed = await rpc('{not json');
  check('malformed JSON is -32700', malformed.json?.error?.code === -32700, `got ${malformed.json?.error?.code}`);
  check('a parse error still carries an id member', malformed.json && 'id' in malformed.json);
}

console.log('\ntools');
{
  const list = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  const tools = list.json?.result?.tools || [];
  check('tools/list returns the six tools', tools.length === 6, `got ${tools.length}`);
  check(
    'every tool declares a title and readOnlyHint',
    tools.every(t => t.title && t.annotations?.readOnlyHint === true)
  );
  check(
    'every tool rejects unknown arguments',
    tools.every(t => t.inputSchema?.additionalProperties === false)
  );
  check('the tool list stays under 16 KB', JSON.stringify(tools).length < 16_000, `${JSON.stringify(tools).length} bytes`);

  const discover = await rpc({ jsonrpc: '2.0', id: 5, method: 'server/discover' });
  check('server/discover is implemented', Boolean(discover.json?.result?.protocolVersions));

  const unknown = await rpc({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'definitely_not_a_tool', arguments: {} },
  });
  check('an unknown tool is a protocol error', unknown.json?.error?.code === -32602, `got ${JSON.stringify(unknown.json?.error)}`);

  const badArgs = await rpc({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'calculate_solo_mining_odds', arguments: { coin_id: 'Bitcoin', hashrate: 'abc', hashrate_unit: 'TH/s' } },
  });
  check('bad arguments are -32602, not a result', badArgs.json?.error?.code === -32602);

  const ambiguous = await rpc({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { name: 'get_coin_oracle', arguments: { coin_id: 'b' } },
  });
  const ambiguousText = JSON.stringify(ambiguous.json?.result ?? ambiguous.json ?? {});
  check(
    'a one-character coin query is refused as ambiguous',
    ambiguous.json?.result?.isError === true || ambiguous.json?.error,
    ambiguousText.slice(0, 160)
  );

  const traversal = await rpc({
    jsonrpc: '2.0',
    id: 9,
    method: 'tools/call',
    params: { name: 'get_cost_of_production', arguments: { coin_id: '../bot_data' } },
  });
  check('a traversal string is rejected', Boolean(traversal.json?.error) || traversal.json?.result?.isError === true);

  const btc = await rpc({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'get_coin_oracle', arguments: { coin_id: 'Bitcoin' } },
  });
  const payload = btc.json?.result?.structuredContent;
  check('a successful call returns structuredContent', Boolean(payload));
  check('every result carries a citable source URL', typeof payload?.source?.url === 'string' && payload.source.url.includes('backpow.com'));
  check('every result carries an as-of timestamp', 'as_of_utc' in (payload?.source || {}));
  check('every result carries a warnings array', Array.isArray(payload?.warnings));

  const coins = await rpc({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'list_pow_coins', arguments: {} },
  });
  // The envelope carries the payload twice: structuredContent for clients that
  // understand it, plus the same JSON serialised into a text block, which the
  // specification asks for so that older clients still see a result. The budget
  // therefore has to allow roughly double the useful content, and the listing
  // is paginated to stay inside it.
  const size = JSON.stringify(coins.json?.result ?? {}).length;
  check('the default coin listing fits a sane token budget', size < 16_000, `${size} bytes`);
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
