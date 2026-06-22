/**
 * ============================================================================
 *  OLLAMA CLIENT  -  the local model runtime
 * ============================================================================
 *
 * All reasoning happens here, on the machine, via Ollama's HTTP API at
 * localhost:11434. There is no cloud model and no API key. The agent loop is
 * model-agnostic: the only thing that changes between models is the `model`
 * string passed to chat().
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  /** For role: "tool" - echoes the tool name this result is for. */
  tool_name?: string;
}

export interface ChatResponse {
  message: OllamaMessage;
}

/** List locally installed Ollama models. */
export async function listModels(): Promise<string[]> {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  return (data.models ?? []).map((m) => m.name).sort();
}

/**
 * One turn of chat with tool-calling enabled. Non-streaming so the agent loop
 * can inspect tool_calls deterministically.
 */
export async function chat(
  model: string,
  messages: OllamaMessage[],
  tools: unknown[],
): Promise<OllamaMessage> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: false,
      // Low temperature keeps tool selection stable for a live demo.
      options: { temperature: 0 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama /api/chat returned ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as ChatResponse;
  return data.message;
}

/** Cheap ping so the first on-stage question isn't slowed by a cold load. */
export async function warmModel(model: string): Promise<void> {
  await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "ready?" }],
      stream: false,
      options: { num_predict: 1 },
    }),
  });
}

export function ollamaHost(): string {
  return OLLAMA_HOST;
}
