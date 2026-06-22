/**
 * ============================================================================
 *  MCP CLIENT  -  the backend's connection to the tool boundary
 * ============================================================================
 *
 * The Express backend never imports the tool implementations directly. Instead
 * it spawns the MCP server (mcp-server) as a child process and talks to it over
 * stdio, exactly as any other MCP host would. This keeps the architecture honest:
 * the only path from the model to local data is across a real MCP boundary.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = resolve(here, "..", "..", "mcp-server", "src", "index.ts");

/** Ollama's tool-definition shape (function calling). */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

let client: Client | null = null;
let cachedTools: OllamaTool[] = [];

/** Connect to the MCP server (idempotent) and cache the tool list. */
export async function initMcp(): Promise<void> {
  if (client) return;

  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: ["--import", "tsx", MCP_ENTRY],
    // Pass demo configuration through to the tool process.
    env: {
      ...process.env,
      DEMO_TODAY: process.env.DEMO_TODAY ?? "2026-06-01",
    } as Record<string, string>,
    stderr: "inherit", // surface the mcp-server's startup log
  });

  const c = new Client({ name: "sovereign-aid-backend", version: "1.0.0" }, { capabilities: {} });
  await c.connect(transport);

  const { tools } = await c.listTools();
  cachedTools = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    },
  }));

  client = c;
}

/** The tool definitions in Ollama's function-calling format. */
export function getOllamaTools(): OllamaTool[] {
  return cachedTools;
}

/**
 * Execute a tool call across the MCP boundary. Returns the parsed JSON result
 * plus a short human-readable summary for the audit strip.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; summary: string }> {
  if (!client) throw new Error("MCP client not initialised");

  const res = await client.callTool({ name, arguments: args ?? {} });

  // MCP returns content blocks; our server always returns a single JSON text block.
  const text =
    Array.isArray(res.content) && res.content[0] && (res.content[0] as any).type === "text"
      ? (res.content[0] as any).text
      : "";

  let result: unknown;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = text; // non-JSON (e.g. an error string)
  }

  return { result, summary: summarize(name, result, Boolean(res.isError)) };
}

/** Compact one-line summary shown in the UI audit strip. */
function summarize(name: string, result: unknown, isError: boolean): string {
  if (isError) return "error";
  if (Array.isArray(result)) return `${result.length} records`;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.count === "number" && Array.isArray(r.families)) return `${r.count} records`;
    if (typeof r.matchCount === "number") return `${r.matchCount} notes matched`;
    if (typeof r.filePath === "string") return `wrote ${r.filePath}`;
    if (typeof r.message === "string") return String(r.message);
    if (r.found === false) return "not found";
    if (r.found === true) return "1 note";
  }
  return "ok";
}

/** Tear down the MCP child process (used on shutdown). */
export async function closeMcp(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
  }
}
