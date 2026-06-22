import type { CaseDetail, ToolCallRecord } from "./api";
import { Markdown } from "./Markdown";
import { Flag, X } from "./icons";

/** What the side panel is currently showing. */
export type PanelContent =
  | { kind: "tool"; call: ToolCallRecord }
  | { kind: "case"; caseId: string; loading: boolean; data?: CaseDetail; error?: string };

const TOOL_LABELS: Record<string, string> = {
  list_cases: "All case records",
  query_cases: "Filtered case records",
  list_notes: "Available field notes",
  read_note: "Field note",
  search_notes: "Note search results",
  flag_case: "Case flagged as priority",
  generate_brief: "Generated situation brief",
};

export function SidePanel({
  content,
  onClose,
  onOpenCase,
}: {
  content: PanelContent | null;
  onClose: () => void;
  onOpenCase: (caseId: string) => void;
}) {
  if (!content) return null;

  const title =
    content.kind === "tool" ? TOOL_LABELS[content.call.name] ?? content.call.name : content.caseId;
  const subtitle =
    content.kind === "tool"
      ? `${content.call.name} · ${content.call.summary}`
      : "Case record + field note";

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <aside className="side-panel" role="dialog" aria-label={title}>
        <div className="side-panel-head">
          <div>
            <div className="side-panel-title">{title}</div>
            <div className="side-panel-sub">{subtitle}</div>
          </div>
          <button className="side-panel-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="side-panel-body">
          {content.kind === "tool"
            ? renderTool(content.call, onOpenCase)
            : renderCase(content, onOpenCase)}
        </div>
      </aside>
    </>
  );
}

// ---- Tool result renderers ------------------------------------------------

function renderTool(call: ToolCallRecord, onOpenCase: (id: string) => void) {
  const r = call.result as any;
  switch (call.name) {
    case "query_cases":
      return (
        <>
          {Array.isArray(r?.filtersApplied) && (
            <div className="filter-row">
              {r.filtersApplied.map((f: string, i: number) => (
                <span className="filter-chip" key={i}>{f}</span>
              ))}
            </div>
          )}
          <FamilyTable rows={r?.families ?? []} onOpenCase={onOpenCase} />
        </>
      );
    case "list_cases":
      return <FamilyTable rows={r ?? []} onOpenCase={onOpenCase} />;
    case "list_notes":
      return (
        <ul className="note-index">
          {(r ?? []).map((n: any) => (
            <li key={n.caseId}>
              <CaseChip id={n.caseId} onOpenCase={onOpenCase} /> {n.familyName} · {n.region}
            </li>
          ))}
        </ul>
      );
    case "read_note":
      return r?.found ? (
        <div className="note-block">
          <CaseChip id={r.caseId} onOpenCase={onOpenCase} />
          <Markdown text={r.note} onCaseClick={onOpenCase} />
        </div>
      ) : (
        <p className="muted">{r?.message ?? "No note found."}</p>
      );
    case "search_notes":
      return (
        <>
          <p className="search-meta">
            Searched for <strong>{(r?.termsSearched ?? []).join(", ")}</strong> · {r?.matchCount ?? 0} match(es)
          </p>
          {(r?.matches ?? []).map((m: any) => (
            <div className="note-block" key={m.caseId}>
              <div className="note-block-head">
                <CaseChip id={m.caseId} onOpenCase={onOpenCase} /> {m.familyName}
              </div>
              <Markdown text={m.note} onCaseClick={onOpenCase} />
            </div>
          ))}
        </>
      );
    case "flag_case":
      return (
        <div className={`flag-result ${r?.ok ? "ok" : "bad"}`}>
          <p>{r?.message}</p>
          {r?.reason && <p className="flag-reason"><strong>Reason:</strong> {r.reason}</p>}
        </div>
      );
    case "generate_brief":
      return (
        <>
          {r?.filePath && (
            <p className="file-path">
              Written to <code>{r.filePath}</code>
            </p>
          )}
          <div className="brief-preview">
            <Markdown text={r?.preview ?? ""} onCaseClick={onOpenCase} />
          </div>
        </>
      );
    default:
      return <pre className="raw-json">{JSON.stringify(call.result, null, 2)}</pre>;
  }
}

function renderCase(
  c: Extract<PanelContent, { kind: "case" }>,
  onOpenCase: (id: string) => void,
) {
  if (c.loading) return <p className="muted">Loading {c.caseId}…</p>;
  if (c.error) return <p className="banner error">{c.error}</p>;
  if (!c.data) return null;
  const rec = c.data.record;
  return (
    <>
      <div className="case-detail">
        <div className="case-detail-name">{rec.familyName}</div>
        <dl className="case-fields">
          <dt>Region</dt><dd>{rec.region}</dd>
          <dt>Household size</dt><dd>{rec.householdSize}</dd>
          <dt>Status</dt>
          <dd>
            {rec.status}
            {rec.priorityFlag && (
              <span className="priority-tag"><Flag size={12} /> PRIORITY</span>
            )}
          </dd>
          <dt>Aid type</dt><dd>{rec.aidType}</dd>
          <dt>Last aid</dt><dd>{rec.lastAidDate ?? "never"} ({rec.daysSinceLastAid})</dd>
        </dl>
      </div>
      <div className="case-note-head">Field note</div>
      {c.data.note ? (
        <Markdown text={c.data.note} onCaseClick={onOpenCase} />
      ) : (
        <p className="muted">No field note on file for this case.</p>
      )}
    </>
  );
}

// ---- Small shared bits ----------------------------------------------------

function FamilyTable({ rows, onOpenCase }: { rows: any[]; onOpenCase: (id: string) => void }) {
  if (!rows.length) return <p className="muted">No matching records.</p>;
  return (
    <table className="panel-table">
      <thead>
        <tr><th>Case</th><th>Family</th><th>Region</th><th>Status</th><th>Last aid</th></tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.caseId}>
            <td><CaseChip id={c.caseId} onOpenCase={onOpenCase} /></td>
            <td>{c.familyName}</td>
            <td>{c.region}</td>
            <td>{c.status}{c.priorityFlag && <Flag size={11} className="inline-flag" />}</td>
            <td>{c.daysSinceLastAid ?? c.lastAidDate ?? "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CaseChip({ id, onOpenCase }: { id: string; onOpenCase: (id: string) => void }) {
  return (
    <button className="case-link" onClick={() => onOpenCase(id)} title={`View ${id}`}>
      {id}
    </button>
  );
}
