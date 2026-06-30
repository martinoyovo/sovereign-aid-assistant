# Building a Local-First AI Assistant with MCP: A Technical Deep Dive

I built the **Sovereign Aid Assistant** — a fully offline AI assistant for NGO case data — to answer a question I kept running into: can you give a local LLM real, auditable access to sensitive data without ever sending that data off the machine? The answer is yes, and the Model Context Protocol (MCP) is the piece that makes it clean. This is a walkthrough of how it's actually built, so you can build something similar.

The short version: a local model (served by [Ollama](https://ollama.com)) never touches data directly. Every fact it states comes through an MCP tool call, the MCP server runs as a genuinely separate process talking over stdio, and the UI streams every tool call live so you can audit exactly what the model saw before it answered.

```
Browser (React) → Express backend → Agent loop → Ollama (local model)
                         ↓
                  MCP client (stdio) → MCP server (7 tools)
                         ↓
                  /data (local JSON + notes)
```

## 1. The tool layer: framework-neutral, model-agnostic

`mcp-server/src/tools.ts` is the **only** module that touches local data. It has no MCP-specific or framework dependency — each tool is just a plain object:

```ts
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (args: Record<string, any>) => Promise<unknown> | unknown;
}
```

That decoupling means the same tool implementations can be exposed over MCP, called directly in tests, or wrapped by a totally different transport later — the protocol is an adapter, not a dependency baked into business logic.

The 7 tools split into three categories:

- **Query** (`list_cases`, `query_cases`) — structured filtering, including date math like "no aid in 60 days." Critically, the date arithmetic happens **inside the tool**, not the model — the model just passes a threshold (`aidGapDays: 60`) and the tool does the computation against a fixed reference date. Don't make a small local model do arithmetic it'll get wrong; give it a tool that does it deterministically.
- **Read/reason** (`list_notes`, `read_note`, `search_notes`) — narrative lookups over Markdown field notes. `search_notes` strips boolean operators and stopwords, then OR-matches terms, to be forgiving of how a local model phrases queries.
- **Action** (`flag_case`, `generate_brief`) — mutate in-memory state or write a real Markdown artifact to disk.

One pattern worth stealing: tool results carry an explicit **instruction field** telling the model how to use the data, e.g. `query_cases` returns something like *"Every family in this list equally satisfies the query — report them as one single list, do not re-filter."* Smaller local models tend to second-guess or silently truncate already-filtered results. Rather than fight that in the system prompt, push the correctness constraint into the tool response itself, right next to the data it governs.

## 2. The MCP server: a thin stdio wrapper

`mcp-server/src/index.ts` wraps `@modelcontextprotocol/sdk`'s `Server` + `StdioServerTransport` around the tool list with two handlers:

```ts
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = getTool(req.params.name);
  if (!tool) return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  try {
    const result = await tool.handler(req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: `Tool error: ...` }] };
  }
});
```

Tool results always come back as a single JSON text block, which keeps client-side parsing trivial. One gotcha worth flagging if you haven't worked with stdio transports before: **stdout is reserved for the MCP protocol stream**, so all logging has to go to stderr — easy to get wrong and silently corrupt the protocol if you don't.

The MCP server runs as a **separate child process**, spawned by the backend and spoken to over stdio — exactly how an IDE or any other MCP host would connect. That's a deliberate constraint, not an implementation detail: it means the only path from model to data crosses a real process boundary and a real protocol, so you can't accidentally let the model shortcut around the tool layer by importing a data module directly somewhere.

## 3. The backend as MCP client, and the Ollama adapter

`server/src/mcpClient.ts` spawns the MCP server and connects as a client:

```ts
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", MCP_ENTRY],
  env: { ...process.env, DEMO_TODAY: process.env.DEMO_TODAY ?? "2026-06-01" },
  stderr: "inherit",
});
const c = new Client({ name: "sovereign-aid-backend", version: "1.0.0" }, { capabilities: {} });
await c.connect(transport);
const { tools } = await c.listTools();
```

The interesting part is the adapter layer right after: MCP's `ListTools` response gets converted into Ollama's function-calling tool shape (`{type: "function", function: {name, description, parameters}}`). This is the piece that actually lets an MCP-described tool be called by a non-Anthropic model API — MCP defines how tools are *described and invoked*, but the model runtime you're using still needs tool definitions in its own dialect. If you're plugging MCP into something other than Claude, expect to write this conversion once and reuse it.

`callTool()` unwraps MCP's `content[]` array, JSON-parses the payload, and also generates a short human-readable summary ("8 records", "wrote brief", "error") used by the UI's live tool-call strip. That summary generation lives in the client adapter, not the tool layer — keeping the MCP tool definitions themselves UI-agnostic.

## 4. The agent loop

`server/src/agent.ts` is a plain while-loop capped at `MAX_ITERATIONS = 5`:

```ts
while (iterations < MAX_ITERATIONS) {
  iterations++;
  onEvent?.({ type: "thinking", iteration: iterations });
  const reply = await chat(model, messages, tools);
  messages.push(reply);

  const calls = reply.tool_calls ?? [];
  if (calls.length === 0) {
    return { answer: (reply.content || "").trim(), toolCalls, model, iterations };
  }
  for (const call of calls) {
    const { result, summary } = await callTool(name, args);
    messages.push({ role: "tool", tool_name: name, content: JSON.stringify(result) });
  }
}
```

The stopping condition is simple: the model returns zero `tool_calls`. If the iteration cap is hit anyway, the loop sends one final message with an empty tools array — effectively "stop calling tools, answer now with what you have" — so a runaway loop degrades to a best-effort answer instead of hanging or erroring. Per-call tool errors are caught and fed back into message history as `{error: message}`, so one failed tool call doesn't blow up the whole turn; the model gets to see the error and react to it.

Progress is reported through a typed event union (`thinking | tool_start | tool_done`) passed via an `onEvent` callback. The loop itself knows nothing about HTTP or SSE — that's the next layer's job, and it's what makes the loop testable in isolation.

The system prompt is more prescriptive than you might expect for a "let the model figure it out" agent: it tells the model which tool to use for which kind of question, explicitly forbids inventing data, and caps the final answer at 1-3 sentences with caseId citations (full provenance is rendered separately by the UI, not generated as prose by the model). For local 4-9GB models, that level of explicit guidance is the difference between reliable tool selection and the model wandering.

## 5. Local model integration

`server/src/ollama.ts` is a plain HTTP client against `localhost:11434` — no SDK. `chat()` calls `/api/chat` with `stream: false`, which is a deliberate choice: the agent loop needs to inspect `tool_calls` as a complete structured object, not parse them out of partial streaming chunks. Streaming is pushed up to the SSE layer instead, at whole-turn (per agent step) granularity rather than token granularity — simplifying both the agent loop and the frontend state machine considerably. Temperature is pinned to `0` for repeatable tool selection. A `warmModel()` call fires a 1-token completion at startup so the first real question isn't paying cold-load latency.

## 6. SSE streaming and the same-boundary guarantee

`server/src/index.ts` is a single Express process serving both the API and the built React app. The `/api/ask/stream` endpoint:

```ts
res.setHeader("Content-Type", "text/event-stream");
res.setHeader("Cache-Control", "no-cache");
res.setHeader("Connection", "keep-alive");
const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

const result = await runAgent(question, model, (evt) => send({ kind: "event", evt }));
send({ kind: "done", result });
```

Each agent event is wrapped in a `{kind: "event", evt}` envelope, with a final `{kind: "done", result}` frame closing the stream (or `{kind: "error", ...}` on failure). That two-level envelope — transport `kind` wrapping the agent's own event union — keeps SSE-specific concerns out of the agent loop's vocabulary.

The detail I'd call out as the real design discipline here: `/api/data` and `/api/case/:caseId`, the endpoints the **UI** uses to render the left panel and case details, go through the exact same MCP `callTool` path the model uses. There's no separate "fast path" that reads files directly for the UI. That means "what the model is capable of knowing" and "what the UI can show" are provably the same boundary — which is what makes the provenance feature trustworthy rather than just decorative.

## 7. Frontend: live tool-call streaming and provenance

`web/src/App.tsx` consumes the SSE stream and reconstructs a `liveSteps` array as events arrive:

```ts
const r = await askStream(q, model, (evt) => {
  if (evt.type === "tool_start") {
    setLiveSteps((s) => [...s, { name: evt.name, args: evt.arguments, done: false }]);
  } else if (evt.type === "tool_done") {
    setLiveSteps((s) => {
      const next = [...s];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].name === evt.call.name && !next[i].done) {
          next[i] = { ...next[i], summary: evt.call.summary, done: true };
          break;
        }
      }
      return next;
    });
  }
});
```

It matches `tool_done` to the most recent not-yet-`done` step with the same name, rather than by index — necessary because the same tool can legitimately be called more than once in a single turn (e.g. `flag_case` per case), and a naive index match would mis-pair them.

Every tool-call step and every caseId citation in the final answer is clickable, opening a slide-in panel with the full raw tool result or case record. That's the actual point of the whole architecture: a non-technical user can trace any claim in the answer back to the exact tool call and underlying record that produced it, with zero trust required in "the model said so."

## 8. Running and configuring Ollama

None of the architecture above matters if the local model layer is flaky, so it's worth being concrete about what running Ollama in this setup actually looks like.

**Install and pull models.** Ollama installs as a background daemon and exposes an HTTP API on `localhost:11434` — that's the entire integration surface; there's no SDK lock-in, just `fetch`. Pull whatever tool-calling-capable models you want to support:

```bash
ollama pull qwen2.5   # ~4.7 GB, recommended primary — reliable tool-calling, fast on a laptop
ollama pull gemma4    # ~9.6 GB, second model for testing model-swap
```

**Not every model can do this.** The whole app depends on Ollama's function-calling `tools` API, and not all locally-served models support it:

| Model | Tool-calling | Notes |
|-------|:---:|-------|
| `qwen2.5` (~4.7 GB) | ✅ | Recommended primary; auto-selected as default. |
| `gemma4` (~9.6 GB) | ✅ | Good model-swap partner, different vendor. |
| `llama3.1` (~4.7 GB) | ✅ | Sends numeric tool args as strings; the tool layer coerces them. |
| `gemma3` / `gemma2` | ❌ | No `tools` chat template in Ollama — fails with `"does not support tools"`. |

Don't assume a model supports function-calling just because it can chat — verify against Ollama's model card, and fail loudly (not silently) when it doesn't. The backend lists whatever's installed via `ollama list`, auto-selects the most reliable option, and if a user manually picks a non-tool-capable model, the agent loop surfaces a clear error instead of the model hallucinating an answer with no tool calls at all.

**Config is just env vars** — there's no config file or admin UI to build:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8000` | Backend / web port. |
| `OLLAMA_HOST` | `http://localhost:11434` | Where the model runtime is listening. |
| `DATA_DIR` | `./data` | Where case data lives — point this anywhere for a different dataset. |
| `DEMO_TODAY` | fixed date | The reference "today" the date-math tools (e.g. `aidGapDays`) compute against — pinned so demos are deterministic instead of drifting with the calendar. |

**Warm the model before the first request.** Ollama loads a model into RAM lazily on first use and unloads it after a few idle minutes, which means the very first question after startup eats a multi-second cold-load penalty. `warmup.ts` fires a throwaway 1-token completion against the default model as soon as the server starts, so that cost is paid once at boot instead of in front of the first real user.

**Hardware is the whole point.** Two recommended models together are about 14 GB on disk; only one is resident in RAM at a time. This runs comfortably on a 32 GB laptop with no GPU requirement — the constraint to design around isn't compute, it's RAM headroom when a user swaps models live (briefly two models loaded at once during the swap). If you're targeting lower-spec hardware, pick a single smaller tool-calling model and skip the live model-swap demo feature entirely.

## What I'd take from this if you're building your own

- **Put correctness logic in the tool, not the prompt.** Date math, filtering guarantees, "don't re-filter this" instructions — anything you can compute or assert deterministically, do it in the tool response rather than hoping the model gets it right. This matters even more on small local models, which need an explicit, prescriptive system prompt and can't be assumed to support tool-calling at all — verify per model and fail loudly when it's missing.
- **Run the MCP server as a real separate process, and route every consumer through it** — including the UI's own data-fetching endpoints, not just the model's. It's a small amount of plumbing for a hard architectural guarantee: there's no path to data, for the model or the UI, that skips the protocol boundary. That's what makes the provenance feature trustworthy rather than decorative.
- **Use whole-turn SSE events, not token streaming**, if your actual UI need is "show me what's happening," not "show me text appearing character by character." It's simpler on both ends and pairs naturally with structured tool-call events.

The full source is in [`sovereign-aid-assistant`](https://github.com/martinoyovo/sovereign-aid-assistant) — MIT licensed, runs with `npm install && npm run dev`, and works completely offline once the models are pulled.
