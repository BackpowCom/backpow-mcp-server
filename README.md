# BackPow MCP Server

The official [Model Context Protocol](https://modelcontextprotocol.io) server for
**BackPow — The Proof of Work Oracle**.

It gives an AI assistant live mining data for 126+ Proof of Work networks and 770+
hardware models: network difficulty and hashrate, Poisson solo-mining
probabilities, Cost of Production, and hardware profitability.

**Remote endpoint:** `https://mcp.backpow.com/mcp` — Streamable HTTP, no API key,
no account.
**Local package:** `@backpow/mcp-server` — the same six tools over stdio.

---

## Install

### Claude Code

```bash
claude mcp add --transport http backpow https://mcp.backpow.com/mcp
```

### Claude Desktop / claude.ai

Settings → Connectors → **Add custom connector** → `https://mcp.backpow.com/mcp`

### VS Code

```json
{
  "servers": {
    "backpow": { "type": "http", "url": "https://mcp.backpow.com/mcp" }
  }
}
```

### Cursor

Settings → MCP → Add, or in `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "backpow": { "url": "https://mcp.backpow.com/mcp" }
  }
}
```

### Local stdio

For clients that run a local process instead of calling a URL. It talks to the
same public endpoints as the remote server, so it needs no key either:

```json
{
  "mcpServers": {
    "backpow": { "command": "npx", "args": ["-y", "@backpow/mcp-server"] }
  }
}
```

---

## Tools

| Tool | Answers |
| --- | --- |
| `calculate_solo_mining_odds` | "How long to solo mine a Bitcoin block at 100 TH/s?" — mean time, Poisson probability over 1/7/30/90/365 days, the luck spread, and what the electricity costs while you wait |
| `get_cost_of_production` | "Is mining Monero profitable?" — CoP vs spot, gross margin, the reference machine and tariff, 30-day trend |
| `get_coin_oracle` | "What is Kaspa's current difficulty?" — live network state with a confidence block |
| `list_pow_coins` | Browse or filter the tracked networks by algorithm or profitability |
| `get_hardware_benchmarks` | "What should I mine with an RTX 4090 at $0.10/kWh?" — coins ranked by net USD/day |
| `get_pow_news` | Recent mining and network events, quoted as third-party content |

All six are read-only and annotated `readOnlyHint`, so hosts that support
auto-approval will not prompt on every call.

## How results are shaped

Every successful result is an envelope:

```jsonc
{
  "warnings": [ /* plain prose caveats that qualify how the figures should be read */ ],
  "source": {
    "as_of_utc": "2026-09-18T08:12:00Z",
    "data_age_seconds": 30,
    "served_from": "live",
    "url": "https://backpow.com/Bitcoin",
    "cite_as": "BackPow — The Proof of Work Oracle, \"BTC solo mining odds\", retrieved 2026-09-18 — https://backpow.com/Bitcoin",
    "methodology": "…"
  },
  "data": { /* the figures */ }
}
```

Difficulty, hashrate and price move continuously, so a figure only means
something alongside the moment it was measured. Every result therefore carries
its measurement timestamp and a ready-made citation line.

Two deliberate behaviours worth knowing:

- **Ambiguity is refused, not guessed.** Several tickers are shared by multiple
  tracked chains (DGB by 5, XVG by 5). `get_coin_oracle {"coin_id": "DGB"}`
  returns an error listing the candidates rather than picking one, so an answer
  is never about a different network than the caller meant.
- **An unavailable measurement is refused, not substituted.** When a network's
  current state cannot be measured, the tool returns an error rather than a
  placeholder such as `0 H/s`, which a caller could not tell apart from a real
  reading.

## Data and licence

Figures derive from BackPow's stratum collector nodes and market data, and are
published under CC BY 4.0 — see [backpow.com/llms.txt](https://backpow.com/llms.txt).
Citation is requested, permission is not required.

This is a calculator and data source, not financial advice. No tool executes a
transaction.

---

## Development

Node 22 or newer is required: the Cloudflare Workers toolchain needs it. The
published package itself runs on Node 20 and above.

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # unit + integration, no network
npm run dev           # wrangler dev on :8787
npm run conformance -- http://127.0.0.1:8787   # protocol probe against a running server
npm run deploy        # Cloudflare Workers
```

`scripts/conformance.mjs` drives a live endpoint through the transport and
security behaviours that only show up over a real HTTP connection: status codes,
header negotiation, origin checks and protocol-version handling. Point it at a
local `wrangler dev` instance, or at the deployed endpoint.

## Transport

Streamable HTTP on a single endpoint, `POST /mcp`. The server is stateless: it
mints no session ids, `GET` and `DELETE` answer `405`, and notifications get
`202` with no body. Protocol revisions `2025-11-25` through `2024-11-05` are
negotiated at `initialize`; `server/discover` reports the supported set.

`/sse` and `/message`, the paths of the deprecated HTTP+SSE transport, answer
`410` pointing at `/mcp`.

## Licence

MIT — see [LICENSE](LICENSE).
