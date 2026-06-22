/**
 * ============================================================================
 *  AGENT LOOP  -  model <-> MCP tools, model-agnostic
 * ============================================================================
 *
 * A minimal but real agentic loop:
 *   1. Send the system prompt + the user question + the MCP tool definitions
 *      to the local model.
 *   2. If the model asks for a tool, run it across the MCP boundary, append the
 *      result, and call the model again.
 *   3. Stop when the model returns a final text answer, or after MAX_ITERATIONS.
 *
 * The loop never changes between models - only the `model` string differs.
 */

import { chat, type OllamaMessage } from "./ollama.js";
import { callTool, getOllamaTools } from "./mcpClient.js";

const MAX_ITERATIONS = 5; // hard cap: prevents a runaway tool loop on stage

export const SYSTEM_PROMPT = `You are the Sovereign Aid Assistant, an offline assistant for a humanitarian NGO's confidential case data. You run entirely on this local machine; no data leaves the device.

Rules:
- ALWAYS use the provided tools to obtain facts. NEVER invent or guess case data, family names, dates, regions, or note contents. If you did not get it from a tool, do not state it.
- For structured or quantitative questions (filters, counts, "no aid in N days", by region/status/aid type), use query_cases. The tool does the date math - you just pick the filter, e.g. aidGapDays: 60.
- For narrative questions ("any protection concerns?", "what's the situation with X"), use list_notes, read_note, and search_notes.
- When asked to take an action - flag, escalate, prioritise - use flag_case. When asked to draft/produce a brief or report, use generate_brief.
- You may call several tools in sequence to complete a multi-step request.
- A tool has ALREADY applied any filter implied by your arguments. When a tool returns a list, your answer must include EVERY record it returned - do not drop, sample, summarise away, or re-filter them, and do not second-guess the result (e.g. if query_cases returns 8 records, list all 8). State how many there are.
- Keep answers short, plain, and free of jargon - they are read by non-technical caseworkers. Cite the caseIds you relied on (always written like C-0003) so they can be linked to their source.
- Keep the final answer to 1-3 sentences. Name the relevant caseIds (e.g. C-0003) but do NOT list each case's fields, and do NOT paste tables, data dumps, or file contents - the interface shows the retrieved records and any generated brief on its own, and the user can click any caseId or step to see the detail. When you create a brief, just say it was created and how many cases it covers.`;

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  summary: string;
  /** Full parsed tool result, so the UI can show exactly what was retrieved. */
  result: unknown;
}

export interface AgentResult {
  answer: string;
  toolCalls: ToolCallRecord[];
  model: string;
  iterations: number;
}

/** Progress events emitted as the loop runs, so the UI can show live activity. */
export type AgentEvent =
  | { type: "thinking"; iteration: number }
  | { type: "tool_start"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_done"; call: ToolCallRecord };

export async function runAgent(
  question: string,
  model: string,
  onEvent?: (e: AgentEvent) => void,
): Promise<AgentResult> {
  const tools = getOllamaTools();
  const messages: OllamaMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];

  const toolCalls: ToolCallRecord[] = [];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    onEvent?.({ type: "thinking", iteration: iterations });
    const reply = await chat(model, messages, tools);
    messages.push(reply);

    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) {
      // Final text answer.
      return { answer: (reply.content || "").trim(), toolCalls, model, iterations };
    }

    // Execute each requested tool call across the MCP boundary.
    for (const call of calls) {
      const name = call.function.name;
      // Ollama usually returns parsed args; tolerate a JSON string too.
      let args: Record<string, unknown> = {};
      const raw = call.function.arguments as unknown;
      if (raw && typeof raw === "object") args = raw as Record<string, unknown>;
      else if (typeof raw === "string") {
        try {
          args = JSON.parse(raw);
        } catch {
          args = {};
        }
      }

      onEvent?.({ type: "tool_start", name, arguments: args });
      try {
        const { result, summary } = await callTool(name, args);
        const record: ToolCallRecord = { name, arguments: args, summary, result };
        toolCalls.push(record);
        onEvent?.({ type: "tool_done", call: record });
        messages.push({ role: "tool", tool_name: name, content: JSON.stringify(result) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const record: ToolCallRecord = {
          name,
          arguments: args,
          summary: `error: ${message}`,
          result: { error: message },
        };
        toolCalls.push(record);
        onEvent?.({ type: "tool_done", call: record });
        messages.push({
          role: "tool",
          tool_name: name,
          content: JSON.stringify({ error: message }),
        });
      }
    }
  }

  // Hit the iteration cap - ask the model for a final answer with no more tools.
  const finalReply = await chat(
    model,
    [
      ...messages,
      {
        role: "user",
        content:
          "Stop calling tools. Using only the tool results above, give your best short answer now.",
      },
    ],
    [],
  );

  return {
    answer:
      (finalReply.content || "").trim() ||
      "I gathered the data but could not finish composing an answer within the step limit.",
    toolCalls,
    model,
    iterations,
  };
}
