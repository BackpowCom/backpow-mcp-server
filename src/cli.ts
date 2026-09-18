#!/usr/bin/env node
/**
 * Local stdio runner for Claude Desktop, Claude Code, Cursor and any terminal
 * agent. Shares the tool registry and dispatch with the Worker via server.ts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  CAPABILITIES,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
  createDeps,
  listTools,
  runTool,
} from './server.js';
import { ToolError } from './errors.js';

async function main(): Promise<void> {
  const server = new Server(
    { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
    { capabilities: CAPABILITIES, instructions: SERVER_INSTRUCTIONS }
  );

  const deps = createDeps({
    apiUrl: process.env.BACKPOW_API_URL,
    siteUrl: process.env.BACKPOW_SITE_URL,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    try {
      return await runTool(name, args ?? {}, deps);
    } catch (err) {
      // runTool re-throws only argument-validation failures; surface them as a
      // tool error the model can correct rather than crashing the connection.
      const data =
        err instanceof ToolError
          ? err.toPayload()
          : { error: 'invalid_arguments', message: 'Invalid arguments.' };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data) }],
        structuredContent: data,
        isError: true,
      };
    }
  });

  // stdout carries the JSON-RPC stream; anything written there that is not a
  // protocol message corrupts the connection, so diagnostics go to stderr.
  await server.connect(new StdioServerTransport());
}

main().catch(err => {
  console.error('Fatal error in BackPow MCP stdio server:', err);
  process.exit(1);
});
