/** Tiny typed wrapper over the local backend API. All requests are same-origin. */

export interface CaseSummary {
  caseId: string;
  familyName: string;
  region: string;
  status: string;
  lastAidDate: string | null;
}

export interface DataSummary {
  cases: CaseSummary[];
  noteCount: number;
  noteCaseIds: string[];
  regions: string[];
}

export interface ToolCallRecord {
  name: string;
  arguments: Record<string, unknown>;
  summary: string;
  result: unknown;
}

export interface CaseDetail {
  caseId: string;
  record: {
    caseId: string;
    familyName: string;
    region: string;
    householdSize: number;
    status: string;
    aidType: string;
    lastAidDate: string | null;
    daysSinceLastAid: string;
    priorityFlag: boolean;
  };
  note: string | null;
}

export interface AgentResult {
  answer: string;
  toolCalls: ToolCallRecord[];
  model: string;
  iterations: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export function fetchModels(): Promise<{ models: string[]; error?: string }> {
  return fetch("/api/models").then((r) => r.json());
}

export function fetchData(): Promise<DataSummary> {
  return getJson<DataSummary>("/api/data");
}

export function fetchCase(caseId: string): Promise<CaseDetail> {
  return getJson<CaseDetail>(`/api/case/${encodeURIComponent(caseId)}`);
}

export interface UploadResult {
  ok: boolean;
  id: string;
  title: string;
  attached: boolean;
  chars: number;
}

export interface UploadPayload {
  filename: string;
  title: string;
  attachToCaseId?: string;
  kind: "text" | "pdf";
  text?: string;
  base64?: string;
}

export async function uploadNote(payload: UploadPayload): Promise<UploadResult> {
  const res = await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data as UploadResult;
}

export async function ask(question: string, model: string): Promise<AgentResult> {
  const res = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, model }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as AgentResult;
}

/** Progress events streamed from the backend while the agent runs. */
export type AgentEvent =
  | { type: "thinking"; iteration: number }
  | { type: "tool_start"; name: string; arguments: Record<string, unknown> }
  | { type: "tool_done"; call: ToolCallRecord };

/**
 * Streaming ask over Server-Sent Events. Calls onEvent for each live agent
 * event (model thinking, tool start/done) and resolves with the final result.
 */
export async function askStream(
  question: string,
  model: string,
  onEvent: (e: AgentEvent) => void,
): Promise<AgentResult> {
  const res = await fetch("/api/ask/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, model }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let final: AgentResult | null = null;
  let errorMsg = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? ""; // keep the trailing partial frame
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const msg = JSON.parse(dataLine.slice(5).trim());
      if (msg.kind === "event") onEvent(msg.evt as AgentEvent);
      else if (msg.kind === "done") final = msg.result as AgentResult;
      else if (msg.kind === "error") errorMsg = msg.error;
    }
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!final) throw new Error("The model did not return a complete response.");
  return final;
}
