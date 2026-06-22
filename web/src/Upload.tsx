import { useRef, useState } from "react";
import { uploadNote, type CaseSummary, type UploadResult } from "./api";
import { FileText } from "./icons";

/**
 * Upload a local document (text / Markdown / PDF) as a field report. The file
 * is read in the browser and sent to the local backend, which stores it on disk
 * and makes it searchable by the agent. Nothing leaves the device - this is the
 * "your documents, your machine" part of the demo.
 */
export function Upload({
  cases,
  onUploaded,
}: {
  cases: CaseSummary[];
  onUploaded: (r: UploadResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [attachTo, setAttachTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const parsed = await readFile(file);
      const r = await uploadNote({
        filename: file.name,
        title: title.trim() || file.name.replace(/\.[^.]+$/, ""),
        attachToCaseId: attachTo || undefined,
        ...parsed,
      });
      setStatus({
        ok: true,
        msg: r.attached
          ? `Added to ${r.id} (${r.chars.toLocaleString()} chars). Ask about it now.`
          : `Added "${r.title}" (${r.chars.toLocaleString()} chars). Ask about it now.`,
      });
      setFile(null);
      setTitle("");
      setAttachTo("");
      if (inputRef.current) inputRef.current.value = "";
      onUploaded(r);
    } catch (err: any) {
      setStatus({ ok: false, msg: String(err.message || err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="uploader">
      <button className="uploader-toggle" onClick={() => setOpen((o) => !o)}>
        <FileText size={14} /> Add a field report
      </button>

      {open && (
        <form className="uploader-form" onSubmit={submit}>
          <input
            ref={inputRef}
            type="file"
            accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setStatus(null);
              if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ""));
            }}
          />
          <input
            type="text"
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <select value={attachTo} onChange={(e) => setAttachTo(e.target.value)}>
            <option value="">Standalone report</option>
            {cases.map((c) => (
              <option key={c.caseId} value={c.caseId}>
                Attach to {c.caseId} — {c.familyName}
              </option>
            ))}
          </select>
          <button type="submit" className="uploader-submit" disabled={!file || busy}>
            {busy ? "Adding…" : "Add to local data"}
          </button>
          <p className="uploader-hint">Text, Markdown, or PDF · stays on this device</p>
        </form>
      )}

      {status && (
        <div className={`uploader-status ${status.ok ? "ok" : "err"}`}>{status.msg}</div>
      )}
    </div>
  );
}

/** Read a file in the browser: PDFs as base64 (parsed server-side), text inline. */
function readFile(
  file: File,
): Promise<{ kind: "text"; text: string } | { kind: "pdf"; base64: string }> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    if (isPdf) {
      reader.onload = () => {
        const dataUrl = String(reader.result);
        resolve({ kind: "pdf", base64: dataUrl.split(",")[1] ?? "" });
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = () => resolve({ kind: "text", text: String(reader.result) });
      reader.readAsText(file);
    }
  });
}
