/**
 * ============================================================================
 *  EXPRESS BACKEND  -  one process, one port
 * ============================================================================
 *
 * Serves the API and the built React frontend as static files. On startup it
 * connects to the MCP server (the tool boundary) and warms each installed
 * Ollama model so the first on-stage question is fast.
 *
 * Routes:
 *   GET  /api/health  -> liveness + data/Ollama status
 *   GET  /api/models  -> installed Ollama models (for the model dropdown)
 *   GET  /api/data    -> human-readable case/notes summary for the left panel
 *   POST /api/ask     -> { question, model } -> { answer, toolCalls, model }
 */

import express from "express";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { PDFParse } from "pdf-parse";

import { initMcp, callTool } from "./mcpClient.js";
import { listModels, warmModel, ollamaHost } from "./ollama.js";
import { runAgent } from "./agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(here, "..", "..", "web", "dist");
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : resolve(here, "..", "..", "data");
const NOTES_DIR = join(DATA_DIR, "notes");
const PORT = Number(process.env.PORT || 8000);

const app = express();
// Larger limit so base64-encoded PDF uploads fit in the JSON body.
app.use(express.json({ limit: "25mb" }));

// --- API ------------------------------------------------------------------

app.get("/api/health", async (_req, res) => {
  let ollamaUp = false;
  try {
    await listModels();
    ollamaUp = true;
  } catch {
    ollamaUp = false;
  }
  res.json({ ok: true, ollama: ollamaUp, ollamaHost: ollamaHost() });
});

app.get("/api/models", async (_req, res) => {
  try {
    const models = await listModels();
    res.json({ models });
  } catch (err) {
    res.status(503).json({
      models: [],
      error: "Could not reach the local model runtime (Ollama). Is it running on localhost:11434?",
    });
  }
});

// Left-panel data: fetched THROUGH the MCP boundary, same as the model uses.
app.get("/api/data", async (_req, res) => {
  try {
    const [casesRes, notesRes] = await Promise.all([
      callTool("list_cases", {}),
      callTool("list_notes", {}),
    ]);
    const cases = (casesRes.result as any[]) ?? [];
    const notes = (notesRes.result as any[]) ?? [];
    const regions = Array.from(new Set(cases.map((c) => c.region))).sort();
    res.json({ cases, noteCount: notes.length, noteCaseIds: notes.map((n) => n.caseId), regions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Could not load local data: ${message}` });
  }
});

// Full detail for one case (record + field note), fetched THROUGH the MCP tools.
// Powers the "click a caseId to see its source" interaction in the UI.
app.get("/api/case/:caseId", async (req, res) => {
  const caseId = req.params.caseId;
  try {
    const [casesRes, noteRes] = await Promise.all([
      callTool("query_cases", {}),
      callTool("read_note", { caseId }),
    ]);
    const families = ((casesRes.result as any)?.families as any[]) ?? [];
    const record = families.find((f) => f.caseId === caseId) ?? null;
    const noteResult = noteRes.result as any;
    const note = noteResult?.found ? noteResult.note : null;
    if (!record) return res.status(404).json({ error: `No case found with id ${caseId}.` });
    res.json({ caseId, record, note });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Could not load case ${caseId}: ${message}` });
  }
});

// Upload a local document (text / Markdown / PDF) as a field note. The file is
// stored on the local disk under /data/notes and becomes searchable by the agent
// immediately - nothing is sent anywhere off the machine.
app.post("/api/notes", async (req, res) => {
  const { filename, title, attachToCaseId, kind, text, base64 } = req.body ?? {};
  try {
    // 1. Resolve the document's plain text.
    let body = "";
    if (kind === "pdf") {
      if (typeof base64 !== "string") return res.status(400).json({ error: "Missing PDF data." });
      const buf = Buffer.from(base64, "base64");
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      try {
        const result = await parser.getText();
        body = (result.text || "").trim();
      } finally {
        await parser.destroy();
      }
      if (!body) return res.status(422).json({ error: "Could not extract any text from that PDF (it may be scanned images)." });
    } else {
      if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "The document is empty." });
      body = text.trim();
    }

    // 2. Decide where it lands: attached to a case, or a standalone report.
    const cleanTitle = (typeof title === "string" && title.trim()) || (filename ?? "Uploaded report");
    let id: string;
    if (typeof attachToCaseId === "string" && /^C-\d{4}$/.test(attachToCaseId)) {
      id = attachToCaseId; // becomes / replaces that case's field note
    } else {
      const slug = String(cleanTitle).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "report";
      id = `DOC-${slug}-${Date.now().toString(36)}`;
    }

    // 3. Write it as Markdown into the local notes directory.
    const heading = body.startsWith("#") ? "" : `# ${cleanTitle}\n\n`;
    if (!existsSync(NOTES_DIR)) mkdirSync(NOTES_DIR, { recursive: true });
    writeFileSync(join(NOTES_DIR, `${id}.md`), heading + body, "utf8");

    res.json({ ok: true, id, title: cleanTitle, attached: id.startsWith("C-"), chars: body.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Could not process the document: ${message}` });
  }
});

// Turn any agent/model error into a friendly message - never a raw stack trace.
function friendlyError(message: string, model: string): string {
  if (/does not support tools/i.test(message)) {
    // The selling point is auditable tool use; a tool-less model can't play.
    return `The model "${model}" does not support tool-calling, which this assistant requires to read the case data. Please pick a tool-capable model (e.g. qwen2.5 or llama3.1) from the dropdown.`;
  }
  if (message.includes("/api/chat") || message.includes("fetch")) {
    return `The local model "${model}" could not be reached or failed to respond. Check that Ollama is running and the model is installed.`;
  }
  return `Something went wrong while answering: ${message}`;
}

// Non-streaming ask (kept for simplicity / compatibility).
app.post("/api/ask", async (req, res) => {
  const { question, model } = req.body ?? {};
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Please provide a question." });
  }
  if (!model || typeof model !== "string") {
    return res.status(400).json({ error: "Please select a model first." });
  }
  try {
    const result = await runAgent(question, model);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: friendlyError(message, model) });
  }
});

// Streaming ask (Server-Sent Events): emits each tool call as it happens, then
// a final "done" frame. This powers the live activity shown while the agent runs.
app.post("/api/ask/stream", async (req, res) => {
  const { question, model } = req.body ?? {};
  if (!question || typeof question !== "string" || !model || typeof model !== "string") {
    return res.status(400).json({ error: "Please provide a question and select a model." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  (res as any).flushHeaders?.();

  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const result = await runAgent(question, model, (evt) => send({ kind: "event", evt }));
    send({ kind: "done", result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send({ kind: "error", error: friendlyError(message, model) });
  }
  res.end();
});

// --- Static frontend -------------------------------------------------------

if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  // SPA fallback for the single page.
  app.get("*", (_req, res) => res.sendFile(resolve(WEB_DIST, "index.html")));
} else {
  app.get("*", (_req, res) =>
    res
      .status(503)
      .send("Frontend not built yet. Run `npm run build:web` (or `npm run dev`)."),
  );
}

// --- Startup ---------------------------------------------------------------

async function start() {
  // 1. Connect to the MCP tool boundary (spawns the mcp-server child process).
  try {
    await initMcp();
    console.log("[server] connected to MCP tool server");
  } catch (err) {
    console.error("[server] FAILED to connect to MCP server:", err);
    process.exit(1);
  }

  // 2. Start listening.
  app.listen(PORT, () => {
    console.log(`\n  Sovereign Aid Assistant - http://localhost:${PORT}`);
    console.log(`  Local model runtime: ${ollamaHost()}\n`);
  });

  // 3. Warm ONLY the default model in the background (non-blocking).
  //    Warming every installed model at once would load them all into RAM
  //    simultaneously (a large model can be 20+ GB) and thrash the machine.
  //    We warm just the one the UI selects by default; others load on demand
  //    when the presenter picks them, and Ollama unloads idle models itself.
  try {
    const models = await listModels();
    if (models.length === 0) {
      console.warn("[server] No Ollama models installed. Run an `ollama pull` first.");
    } else {
      const target = pickWarmModel(models);
      console.log(`[server] warming default model: ${target} (others load on demand)`);
      warmModel(target).catch(() => {/* best-effort warm-up */});
    }
  } catch {
    console.warn("[server] Ollama not reachable at startup - start it before the demo.");
  }
}

// Keep this in sync with PREFERRED_MODELS in web/src/App.tsx so the model warmed
// at startup is the same one the UI auto-selects.
const PREFERRED_MODELS = ["qwen3.6", "qwen3", "qwen2.5", "llama3.1", "gemma4", "mistral-nemo", "llama3.2"];

function pickWarmModel(models: string[]): string {
  for (const pref of PREFERRED_MODELS) {
    const hit = models.find((m) => m === pref || m.startsWith(pref + ":"));
    if (hit) return hit;
  }
  return models[0];
}

start();
