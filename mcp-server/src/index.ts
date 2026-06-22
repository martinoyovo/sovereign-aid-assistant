/**
 * ============================================================================
 *  MCP SERVER  -  standalone, stdio transport
 * ============================================================================
 *
 * Wraps the framework-neutral tool layer (./tools.ts) in a real Model Context
 * Protocol server. The Node backend spawns this file as a child process and
 * connects to it as an MCP client over stdio. Because it is a clean separate
 * process speaking MCP, it can equally be pointed at any other MCP-capable
 * host (e.g. an IDE) without modification.
 *
 * Run standalone:  npm run mcp
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tools, getTool, dataSummary } from "./tools.js";

const server = new Server(
  { name: "sovereign-aid-assistant-tools", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// Advertise the 7 tools with their JSON Schemas.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

// Execute a tool call and return its result as MCP text content (JSON).
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = getTool(req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await tool.handler(req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Tool error: ${message}` }] };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe to log to; stdout is reserved for the MCP protocol stream.
  const s = dataSummary();
  console.error(
    `[mcp-server] ready · ${s.caseCount} cases · ${s.noteCount} notes · DEMO_TODAY=${s.demoToday}`,
  );
}

main().catch((err) => {
  console.error("[mcp-server] fatal:", err);
  process.exit(1);
});
