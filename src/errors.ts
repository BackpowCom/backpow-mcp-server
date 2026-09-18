/**
 * Structured tool errors.
 *
 * Every failure a caller can act on carries a machine-readable `code` and a
 * `data` payload. The transports turn argument errors into JSON-RPC -32602 and
 * everything else into an `isError: true` tool result whose text tells the
 * model how to recover (which is what the MCP spec asks for: tool errors should
 * contain actionable feedback the model can self-correct from).
 */

export type ToolErrorCode =
  | 'invalid_arguments'
  | 'unknown_coin'
  | 'ambiguous_coin'
  | 'unknown_hardware'
  | 'data_unavailable'
  | 'upstream_unavailable';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly data: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.data = data;
  }

  /** Serialized form handed to the model alongside the human-readable message. */
  toPayload(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.data };
  }
}

export function invalidArguments(message: string, data: Record<string, unknown> = {}): ToolError {
  return new ToolError('invalid_arguments', message, data);
}

export function unknownCoin(query: string, didYouMean: string[] = []): ToolError {
  const hint = didYouMean.length
    ? ` Did you mean: ${didYouMean.join(', ')}?`
    : ' Call list_pow_coins to see the tracked networks.';
  return new ToolError('unknown_coin', `Unknown coin "${query}".${hint}`, {
    query,
    did_you_mean: didYouMean,
  });
}

export function ambiguousCoin(query: string, candidates: string[]): ToolError {
  return new ToolError(
    'ambiguous_coin',
    `"${query}" is ambiguous — it matches ${candidates.length} tracked networks: ` +
      `${candidates.slice(0, 10).join(', ')}` +
      `${candidates.length > 10 ? ', …' : ''}. Call again with one exact coin id.`,
    { query, candidates }
  );
}

export function upstreamUnavailable(what: string): ToolError {
  return new ToolError(
    'upstream_unavailable',
    `BackPow data for ${what} is temporarily unavailable. This is a transient failure, ` +
      `not a statement about coverage — do not report it as "no data exists". Retry shortly.`,
    { retryable: true }
  );
}

export function dataUnavailable(what: string, why: string): ToolError {
  return new ToolError('data_unavailable', `${what} is not available: ${why}`, {
    retryable: false,
  });
}
