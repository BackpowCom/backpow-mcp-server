# Security Policy

## What this server is

The BackPow MCP server exposes **read-only public Proof of Work mining data**:
difficulty and hashrate, solo mining probabilities, cost of production, hardware
benchmarks and PoW news — the same data published on
[backpow.com](https://backpow.com).

- **No authentication.** No accounts, API keys or tokens.
- **No database.** The server keeps no store of its own: tool arguments are used
  to answer the call and are not written anywhere by the application.
- **No writes.** No tool mutates state, moves funds, or acts on a user's behalf.
- **No secrets shipped.** The npm CLI talks to the same public endpoints.

What the platform retains is a separate matter, and worth stating plainly. The
remote server runs on Cloudflare Workers, so Cloudflare records each invocation
the way any web host does — source IP, timestamp and request metadata — under
its own retention policy, and Workers observability is enabled for operational
diagnostics. Some tool arguments describe a caller's setup rather than a public
fact: an electricity tariff and a rig's power draw say something about their
costs. They travel in the request body and are not logged by the application,
but they do reach the platform as part of the request.

Callers who would rather not send those values over the network can run the
stdio server locally, or use the calculator on
[backpow.com](https://backpow.com), which computes in the browser. The full
statement is at [backpow.com/privacy](https://backpow.com/privacy).

Only the latest npm release and the deployed Worker receive fixes.

## Reporting a vulnerability

Report privately — please do not open a public GitHub issue.

- **Preferred:** GitHub **Security → Advisories → Report a vulnerability** on
  [BackpowCom/backpow-mcp-server](https://github.com/BackpowCom/backpow-mcp-server/security/advisories/new).
  This is private, goes straight to the BackPow security team, and needs no other
  account.
- Alternatively, email <admin.backpow@proton.me>.

Include the affected endpoint or tool and steps to reproduce. We aim to
acknowledge within 5 business days and to ship a validated fix promptly. Please
allow a reasonable window before public disclosure. There is **no paid bug
bounty**; reporters who want it are credited in the release notes for the fix.

## Scope

In scope: this repository, the published npm package, and the
`mcp.backpow.com` endpoint — e.g. injection via tool arguments, SSRF in
server-side data fetching, cache poisoning, or a response that could push an MCP
client into an unintended action.

Out of scope: questions about the figures themselves, such as accuracy or
freshness (open a normal issue), volumetric denial of service, missing headers
with no demonstrated impact, and third-party infrastructure such as Cloudflare
or npm.
