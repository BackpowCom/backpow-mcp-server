import { describe, it, expect } from 'vitest';

import { BACKPOW_TOOLS, dispatchTool, isToolName } from '../src/tools/registry.js';
import { ToolDeps } from '../src/tools/deps.js';
import { ToolError } from '../src/errors.js';

/**
 * Argument validation runs before any handler, so a bare object is enough to
 * exercise it — every case below must be rejected before a client is touched.
 */
const deps = {} as unknown as ToolDeps;

async function expectRejected(tool: string, args: unknown): Promise<ToolError> {
  try {
    await dispatchTool(tool, args, deps);
  } catch (err) {
    expect(err).toBeInstanceOf(ToolError);
    return err as ToolError;
  }
  throw new Error(`expected ${tool} to reject ${JSON.stringify(args)}`);
}

describe('tool definitions', () => {
  it('exposes a stable, discoverable surface', () => {
    const names = BACKPOW_TOOLS.map(t => t.name);
    expect(names).toEqual([
      'calculate_solo_mining_odds',
      'get_cost_of_production',
      'get_coin_oracle',
      'list_pow_coins',
      'get_hardware_benchmarks',
      'get_pow_news',
    ]);
  });

  it('carries the annotations the specification requires', () => {
    // Every tool MUST carry a title and the hints that apply to it. All six
    // tools only read published data, so readOnlyHint is true and
    // destructiveHint false throughout; hosts use these to decide whether a
    // call needs the user's confirmation.
    for (const tool of BACKPOW_TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.name.length).toBeLessThanOrEqual(64);
      expect(tool.annotations.title.length).toBeGreaterThan(0);
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });

  it('describes when to use each tool, not just what it does', () => {
    // Three of the tools take nothing but coin_id, so the description is the
    // only signal a model has to route a question such as "tell me about
    // mining Bitcoin" to the right one.
    for (const tool of BACKPOW_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(200);
      expect(tool.description).toMatch(/\bUse (for|to|when)\b/);
    }
  });

  it('declares a closed argument schema on every tool', () => {
    for (const tool of BACKPOW_TOOLS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('keeps the whole tool list within a sane context budget', () => {
    const bytes = JSON.stringify(BACKPOW_TOOLS).length;
    expect(bytes).toBeLessThan(16_000);
  });
});

describe('argument validation', () => {
  it('knows its own tool names', () => {
    expect(isToolName('get_coin_oracle')).toBe(true);
    expect(isToolName('nope')).toBe(false);
  });

  it('rejects an unknown tool with the available list', async () => {
    const err = await expectRejected('nope', {});
    expect(err.code).toBe('invalid_arguments');
    expect(err.data.available_tools).toContain('get_coin_oracle');
  });

  it('rejects a hashrate that is not a positive finite number', async () => {
    // A hashrate is a divisor in the waiting-time calculation. A string, NaN
    // or a non-positive value has no meaning there, and comparisons against
    // NaN are all false, so the type and range are checked up front.
    for (const hashrate of ['abc', '100', {}, null, NaN, Infinity, -1, 0]) {
      const err = await expectRejected('calculate_solo_mining_odds', {
        coin_id: 'Bitcoin',
        hashrate,
        hashrate_unit: 'TH/s',
      });
      expect(err.code).toBe('invalid_arguments');
    }
  });

  it('rejects an argument the tool does not support', async () => {
    // get_coin_oracle has no electricity tariff to apply. Accepting the
    // argument and ignoring it would return the default figures while the
    // caller believed their own tariff had been used.
    const err = await expectRejected('get_coin_oracle', {
      coin_id: 'Bitcoin',
      electricity_cost_usd_kwh: 0.3,
    });
    expect(err.code).toBe('invalid_arguments');
  });

  it('rejects a coin_id that could alter a URL path', async () => {
    for (const coin_id of ['../bot_data', '..\\bot_data', 'a/b', 'x?y', '']) {
      const err = await expectRejected('get_coin_oracle', { coin_id });
      expect(err.code).toBe('invalid_arguments');
    }
  });

  it('rejects an out-of-range limit rather than clamping it', async () => {
    const err = await expectRejected('get_pow_news', { limit: 999 });
    expect(err.code).toBe('invalid_arguments');
  });

  it('rejects a one-character hardware query', async () => {
    // A single character matches most device names in the index, so the reply
    // would be close to the whole catalogue: too large to be useful and too
    // broad to be an answer.
    const err = await expectRejected('get_hardware_benchmarks', { query: 'a' });
    expect(err.code).toBe('invalid_arguments');
  });

  it('rejects an implausible electricity rate', async () => {
    const err = await expectRejected('get_cost_of_production', {
      coin_id: 'Bitcoin',
      electricity_cost_usd_kwh: -5,
    });
    expect(err.code).toBe('invalid_arguments');
  });
});
