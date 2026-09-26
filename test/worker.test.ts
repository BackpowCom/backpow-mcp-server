import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';
import { AGENT_CARD, ROBOTS_TXT, SERVER_MANIFEST } from '../src/discovery.js';

describe('Worker HTTP endpoints & discovery routing', () => {
  const env = {};
  const ctx = {} as ExecutionContext;

  it('serves /.well-known/agent-card.json with 200 and valid JSON', async () => {
    const req = new Request('https://mcp.backpow.com/.well-known/agent-card.json');
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const data = await res.json() as typeof AGENT_CARD;
    expect(data.name).toBe('BackPow PoW Oracle');
    expect(data.skills.length).toBe(6);
    expect(data.skills.map(s => s.id)).toEqual([
      'calculate_solo_mining_odds',
      'get_cost_of_production',
      'get_coin_oracle',
      'list_pow_coins',
      'get_hardware_benchmarks',
      'get_pow_news',
    ]);
  });

  it('serves /.well-known/agent.json with 200 for legacy A2A bots', async () => {
    const req = new Request('https://mcp.backpow.com/.well-known/agent.json');
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual(AGENT_CARD);
  });

  it('serves MCP server manifests via /.well-known/mcp/server.json and /server.json', async () => {
    for (const path of ['/.well-known/mcp/server.json', '/server.json']) {
      const req = new Request(`https://mcp.backpow.com${path}`);
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual(SERVER_MANIFEST);
    }
  });

  it('serves /robots.txt with 200 and allows indexing', async () => {
    const req = new Request('https://mcp.backpow.com/robots.txt');
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toBe(ROBOTS_TXT);
    expect(text).toContain('Allow: /');
  });

  it('returns 404 for unknown endpoints', async () => {
    const req = new Request('https://mcp.backpow.com/unknown-path');
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(404);
  });

  it('serves /openapi.json and /.well-known/openapi.json with 200', async () => {
    for (const path of ['/openapi.json', '/.well-known/openapi.json']) {
      const req = new Request(`https://mcp.backpow.com${path}`);
      const res = await worker.fetch(req, env, ctx);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const data = (await res.json()) as any;
      expect(data.openapi).toBe('3.1.0');
      expect(data.info.title).toContain('BackPow');
      expect(data.paths['/v1/cost-of-production']).toBeTruthy();
      expect(data.paths['/v1/solo-mining-odds']).toBeTruthy();
    }
  });

  it('handles REST GET /v1/cost-of-production', async () => {
    const req = new Request('https://mcp.backpow.com/v1/cost-of-production?coin_id=Bitcoin');
    const res = await worker.fetch(req, env, ctx);

    expect([200, 400]).toContain(res.status);
    const json = (await res.json()) as any;
    expect(json).toBeTruthy();
  });
});
