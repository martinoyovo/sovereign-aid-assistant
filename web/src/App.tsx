import { useEffect, useState } from "react";
import {
  askStream,
  fetchCase,
  fetchData,
  fetchModels,
  type AgentResult,
  type DataSummary,
  type ToolCallRecord,
} from "./api";
import { Answer } from "./Answer";
import { SidePanel, type PanelContent } from "./SidePanel";
import { Upload } from "./Upload";
import { ArrowRight, Check } from "./icons";

const EXAMPLE_QUESTIONS = [
  "Which families have not received aid in the last 60 days?",
  "Are there any protection concerns I should know about?",
  "Flag the urgent cases and draft a situation brief.",
];

// Models with the most reliable tool-calling in Ollama, in preference order.
// On first load we auto-select the best available rather than whatever sorts
// first alphabetically - so the demo doesn't default to a flaky model.
const PREFERRED_MODELS = ["qwen3.6", "qwen3", "qwen2.5", "llama3.1", "gemma4", "mistral-nemo", "llama3.2"];

function pickDefaultModel(models: string[]): string {
  for (const pref of PREFERRED_MODELS) {
    const hit = models.find((m) => m === pref || m.startsWith(pref + ":"));
    if (hit) return hit;
  }
  return models[0] ?? "";
}

export default function App() {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>("");
  const [modelError, setModelError] = useState<string>("");

  const [data, setData] = useState<DataSummary | null>(null);

  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string>("");

  // Tool calls streamed live while the agent is still working.
  type LiveStep = { name: string; args: Record<string, unknown>; summary?: string; done: boolean };
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);

  // The slide-in provenance panel (a tool's retrieved data, or a case detail).
  const [panel, setPanel] = useState<PanelContent | null>(null);

  function openTool(call: ToolCallRecord) {
    setPanel({ kind: "tool", call });
  }

  async function openCase(caseId: string) {
    setPanel({ kind: "case", caseId, loading: true });
    try {
      const data = await fetchCase(caseId);
      setPanel({ kind: "case", caseId, loading: false, data });
    } catch (e: any) {
      setPanel({ kind: "case", caseId, loading: false, error: String(e.message || e) });
    }
  }

  // caseId currently shown in the panel, used to highlight it in the left list.
  const activeCaseId = panel?.kind === "case" ? panel.caseId : null;

  // Load installed models + local data on mount.
  useEffect(() => {
    fetchModels().then((r) => {
      setModels(r.models);
      if (r.models.length > 0) setModel(pickDefaultModel(r.models));
      if (r.error) setModelError(r.error);
    });
    fetchData()
      .then(setData)
      .catch((e) => setError(String(e.message || e)));
  }, []);

  async function submit(q: string) {
    if (!q.trim() || loading) return;
    if (!model) {
      setError("No local model selected. Install one with `ollama pull` and reload.");
      return;
    }
    setLoading(true);
    setError("");
    setResult(null);
    setLiveSteps([]);
    try {
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
      setResult(r);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  function formatArgs(args: Record<string, unknown>): string {
    return Object.entries(args || {})
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>Sovereign Aid Assistant</h1>
          <span className="badge"><span className="badge-dot" /> Running locally - no internet</span>
        </div>
        <div className="header-right">
          <label className="model-label" htmlFor="model">
            Model
          </label>
          <select
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={models.length === 0}
          >
            {models.length === 0 && <option>(no models installed)</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </header>

      {modelError && <div className="banner warn">{modelError}</div>}

      <div className="layout">
        {/* LEFT: the local data, human-readable */}
        <aside className="panel data-panel">
          <h2>Local case data</h2>
          {data ? (
            <>
              <p className="count">
                {data.cases.length} case records · {data.noteCount} field notes
              </p>
              <p className="regions">Regions: {data.regions.join(" · ")}</p>
              <ul className="case-list">
                {data.cases.map((c) => (
                  <li key={c.caseId}>
                    <button
                      className={`case-row${activeCaseId === c.caseId ? " active" : ""}`}
                      onClick={() => openCase(c.caseId)}
                    >
                      <span className="case-id">{c.caseId}</span>
                      <span className="case-name">{c.familyName}</span>
                      <span className={`status status-${c.status}`}>{c.status}</span>
                      <span className="case-region">{c.region}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="data-foot">Loaded from local files on this device</p>
              <Upload
                cases={data.cases}
                onUploaded={() => fetchData().then(setData).catch(() => {})}
              />
            </>
          ) : (
            <p className="muted">Loading local data…</p>
          )}
        </aside>

        {/* CENTER: ask + answer */}
        <main className="panel ask-panel">
          <div className="examples">
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                className="chip"
                onClick={() => {
                  setQuestion(q);
                  submit(q);
                }}
                disabled={loading}
              >
                {q}
              </button>
            ))}
          </div>

          <form
            className="ask-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(question);
            }}
          >
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask about the case records in plain language…"
              rows={2}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(question);
                }
              }}
            />
            <button type="submit" className="send" disabled={loading || !question.trim()}>
              {loading ? "Thinking…" : "Ask"}
            </button>
          </form>

          {error && <div className="banner error">{error}</div>}

          {loading && (
            <div className="thinking">
              <div className="thinking-head">
                <span className="spinner" /> The local model is reasoning and calling tools…
              </div>
              {liveSteps.length > 0 && (
                <ol className="live-steps">
                  {liveSteps.map((s, i) => (
                    <li key={i} className={s.done ? "live-done" : "live-running"}>
                      <span className="live-icon">
                        {s.done ? <Check size={14} /> : <span className="mini-spinner" />}
                      </span>
                      <span className="live-content">
                        <code className="live-call">{s.name}({formatArgs(s.args)})</code>
                        {s.done && (
                          <span className="live-summary">
                            <ArrowRight size={13} /> {s.summary}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {result && !loading && (
            <Answer result={result} onOpenTool={openTool} onOpenCase={openCase} />
          )}

          {!result && !loading && !error && (
            <div className="placeholder">
              Ask a question above, or tap an example. Every answer is produced by the local
              model using only the case tools - click any step or caseId to see exactly what it
              retrieved.
            </div>
          )}
        </main>
      </div>

      <SidePanel content={panel} onClose={() => setPanel(null)} onOpenCase={openCase} />
    </div>
  );
}
