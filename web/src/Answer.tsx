import type { AgentResult, ToolCallRecord } from "./api";
import { Markdown } from "./Markdown";
import { ArrowRight, FileText } from "./icons";

/**
 * Renders the model's final answer as clean prose whose caseId citations are
 * clickable, plus an interactive provenance strip: each tool call is a button
 * that opens its retrieved data in the side panel. Any generated brief is
 * surfaced as its own "open" card rather than dumped inline. This is the
 * auditability story made tangible - every claim links back to its source.
 */
export function Answer({
  result,
  onOpenTool,
  onOpenCase,
}: {
  result: AgentResult;
  onOpenTool: (call: ToolCallRecord, index: number) => void;
  onOpenCase: (caseId: string) => void;
}) {
  const briefIndex = result.toolCalls.findIndex((t) => t.name === "generate_brief");
  const brief = briefIndex >= 0 ? result.toolCalls[briefIndex] : null;
  const briefResult = brief?.result as { filePath?: string; caseCount?: number } | undefined;

  return (
    <div className="answer">
      <div className="answer-body">
        <Markdown text={result.answer} onCaseClick={onOpenCase} />
      </div>

      {brief && (
        <button className="artifact-card" onClick={() => onOpenTool(brief, briefIndex)}>
          <span className="artifact-icon"><FileText size={22} /></span>
          <span className="artifact-text">
            <span className="artifact-title">Situation brief generated</span>
            <span className="artifact-sub">
              {briefResult?.caseCount ?? "?"} cases · click to open
            </span>
          </span>
          <span className="artifact-open">Open <ArrowRight size={15} /></span>
        </button>
      )}

      <div className="audit">
        <div className="audit-head">
          Provenance · model <code>{result.model}</code> · click a step to see what it retrieved
        </div>
        {result.toolCalls.length === 0 ? (
          <div className="audit-line muted">
            (no tools called - the model answered without consulting the data)
          </div>
        ) : (
          <ol className="audit-steps">
            {result.toolCalls.map((tc, i) => (
              <li key={i}>
                <button className="audit-step-btn" onClick={() => onOpenTool(tc, i)}>
                  <code className="audit-call">{formatCall(tc)}</code>
                  <ArrowRight size={13} className="audit-arrow" />
                  <span className="audit-summary">{tc.summary}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function formatCall(tc: ToolCallRecord): string {
  const args = Object.entries(tc.arguments || {})
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join(", ");
  return `${tc.name}(${args})`;
}
