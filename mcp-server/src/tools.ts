/**
 * ============================================================================
 *  MCP TOOL LAYER  -  the data/action boundary
 * ============================================================================
 *
 * This module is the ONLY thing in the system that touches local case data.
 * The language model never reads files directly; it can only act by asking
 * for one of the tools defined here. That makes the boundary auditable: every
 * fact in an answer corresponds to a tool call recorded below.
 *
 * The module is deliberately framework-neutral - each tool is a plain
 * { name, description, inputSchema (JSON Schema), handler } record. `index.ts`
 * wraps these in a real Model Context Protocol server (stdio transport); the
 * same definitions could be mounted on any other transport without change.
 *
 * All data is loaded into memory on startup from local files under /data.
 * Nothing in here makes a network call.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Repo data directory. Override with DATA_DIR; defaults to <repo>/data. */
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(here, "..", "..", "data");

const NOTES_DIR = join(DATA_DIR, "notes");
const BRIEFS_DIR = join(DATA_DIR, "briefs");

/**
 * "Today" for the demo. Fixed by default so the 60-day-gap query returns the
 * same deterministic set regardless of the wall-clock date the demo is run on.
 */
const DEMO_TODAY = process.env.DEMO_TODAY || "2026-06-01";

// ---------------------------------------------------------------------------
//  Data types + in-memory store
// ---------------------------------------------------------------------------

export interface CaseRecord {
  caseId: string;
  familyName: string;
  region: string;
  householdSize: number;
  registeredDate: string;
  lastAidDate: string | null;
  aidType: string;
  status: "active" | "pending" | "closed";
  priorityFlag: boolean;
  /** Populated by flag_case; not part of the source file. */
  flagReason?: string;
}

let CASES: CaseRecord[] = [];
let NOTES: Map<string, string> = new Map(); // caseId -> note text

// Re-read all field notes from disk. Cheap (a handful of small files) and called
// before every notes operation so documents uploaded at runtime are picked up
// immediately, without restarting the server. (Cases are loaded once because
// flag_case mutates them in memory.)
function reloadNotes(): void {
  NOTES = new Map();
  if (existsSync(NOTES_DIR)) {
    for (const file of readdirSync(NOTES_DIR)) {
      if (!file.endsWith(".md")) continue;
      NOTES.set(file.replace(/\.md$/, ""), readFileSync(join(NOTES_DIR, file), "utf8"));
    }
  }
}

function loadData(): void {
  CASES = JSON.parse(readFileSync(join(DATA_DIR, "cases.json"), "utf8"));
  reloadNotes();
}
loadData();

/** Human-readable label for a note id: the family name if it maps to a case,
 *  otherwise the document's first Markdown heading, else the id itself. */
function noteTitle(id: string): string {
  const c = CASES.find((x) => x.caseId === id);
  if (c) return `${c.familyName} (${id})`;
  const text = NOTES.get(id) ?? "";
  const heading = text.split("\n").find((l) => l.startsWith("# "));
  return heading ? heading.replace(/^#\s+/, "").trim() : id;
}

// ---------------------------------------------------------------------------
//  Date helpers - the date math lives in the TOOL, never in the model.
// ---------------------------------------------------------------------------

function parseDate(d: string): number {
  // Treat YYYY-MM-DD as a UTC midnight to avoid timezone drift.
  return Date.parse(`${d}T00:00:00Z`);
}

/** Days since last aid relative to DEMO_TODAY. null lastAidDate => Infinity. */
function aidGapDays(c: CaseRecord): number {
  if (!c.lastAidDate) return Infinity;
  const ms = parseDate(DEMO_TODAY) - parseDate(c.lastAidDate);
  return Math.floor(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
//  Tool definition shape
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (args: Record<string, any>) => Promise<unknown> | unknown;
}

// ---------------------------------------------------------------------------
//  The 7 tools
// ---------------------------------------------------------------------------

export const tools: ToolDef[] = [
  // --- Query tools (structured cases.json) -------------------------------
  {
    name: "list_cases",
    description:
      "List every case record with its core fields (caseId, family, region, status, lastAidDate). Use to get an overview of all families on file.",
    inputSchema: { type: "object", properties: {} },
    handler: () =>
      CASES.map((c) => ({
        caseId: c.caseId,
        familyName: c.familyName,
        region: c.region,
        status: c.status,
        lastAidDate: c.lastAidDate,
      })),
  },
  {
    name: "query_cases",
    description:
      "Filter case records. Use this for any structured/quantitative question. " +
      "Optional filters: region, status (active|pending|closed), aidType, and " +
      "aidGapDays (a number N). aidGapDays returns families whose last aid was " +
      "more than N days ago relative to the operational date; families that have " +
      "never received aid always count as a gap. The date math is done here - you " +
      "only choose the filter (e.g. aidGapDays: 60 for 'no aid in the last 60 days').",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string", description: "Exact region name, e.g. 'Eastern Sector'." },
        status: {
          type: "string",
          enum: ["active", "pending", "closed"],
          description: "Case status filter.",
        },
        aidType: { type: "string", description: "Exact aid type, e.g. 'Food + Water'." },
        aidGapDays: {
          type: "number",
          description: "Return families whose last aid was more than this many days ago.",
        },
      },
    },
    handler: (args) => {
      let result = CASES.slice();
      const applied: string[] = [];
      if (args.region) {
        result = result.filter((c) => c.region === args.region);
        applied.push(`region = ${args.region}`);
      }
      if (args.status) {
        result = result.filter((c) => c.status === args.status);
        applied.push(`status = ${args.status}`);
      }
      if (args.aidType) {
        result = result.filter((c) => c.aidType === args.aidType);
        applied.push(`aidType = ${args.aidType}`);
      }
      // Coerce defensively: some models pass numeric args as strings ("60").
      const gapRaw = args.aidGapDays;
      const gapNum =
        typeof gapRaw === "number"
          ? gapRaw
          : typeof gapRaw === "string" && gapRaw.trim() !== ""
            ? Number(gapRaw)
            : NaN;
      if (!Number.isNaN(gapNum)) {
        result = result.filter((c) => aidGapDays(c) > gapNum);
        applied.push(`last aid more than ${gapNum} days ago (never-aided families included)`);
      }

      const families = result.map((c) => ({
        caseId: c.caseId,
        familyName: c.familyName,
        region: c.region,
        householdSize: c.householdSize,
        status: c.status,
        aidType: c.aidType,
        lastAidDate: c.lastAidDate,
        daysSinceLastAid: aidGapDays(c) === Infinity ? "never received aid" : `${aidGapDays(c)} days ago`,
        priorityFlag: c.priorityFlag,
      }));

      // Return a self-describing result: every family listed already satisfies
      // the filter, so the model should report ALL of them and not re-judge.
      return {
        filtersApplied: applied.length ? applied : ["none"],
        count: families.length,
        instruction:
          "Every family in this list equally satisfies the query - including those that have " +
          "never received aid AND those whose last aid was simply more than the threshold ago. " +
          "Report them as one single list of matches. Do NOT split them into 'matches' vs " +
          "'context', do not drop any, and do not re-filter. State the total count.",
        families,
      };
    },
  },

  // --- Read/reason tools (notes/) ----------------------------------------
  {
    name: "list_notes",
    description:
      "List the field notes on file (case notes and any uploaded reports), with the id and a title. Use before reading or searching notes.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      reloadNotes();
      return Array.from(NOTES.keys())
        .sort()
        .map((caseId) => {
          const c = CASES.find((x) => x.caseId === caseId);
          return {
            caseId,
            familyName: c?.familyName ?? noteTitle(caseId),
            region: c?.region ?? null,
            title: noteTitle(caseId),
            uploaded: !c,
          };
        });
    },
  },
  {
    name: "read_note",
    description: "Return the full text of a single field note by its id (a caseId like 'C-0003', or an uploaded document id).",
    inputSchema: {
      type: "object",
      properties: { caseId: { type: "string", description: "e.g. 'C-0003' or an uploaded document id." } },
      required: ["caseId"],
    },
    handler: (args) => {
      reloadNotes();
      const text = NOTES.get(args.caseId);
      if (!text) return { caseId: args.caseId, found: false, message: "No field note on file for this case." };
      return { caseId: args.caseId, found: true, note: text };
    },
  },
  {
    name: "search_notes",
    description:
      "Search all field notes (case-insensitive) and return the matching notes. " +
      "Use this for narrative questions. Prefer a SINGLE keyword such as 'protection' or " +
      "'urgent'. Do not use boolean operators (AND/OR) or quotes; if you pass several words " +
      "the tool returns notes that contain ANY of them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A single keyword, e.g. 'protection' or 'urgent'." },
      },
      required: ["query"],
    },
    handler: (args) => {
      reloadNotes();
      const raw = String(args.query || "").toLowerCase();
      // Be forgiving of multi-term / boolean-style queries that some models emit
      // (e.g. "urgent OR concern"). Strip operators/punctuation and match if a
      // note contains ANY remaining term, so the search rarely returns nothing.
      const STOP = new Set(["or", "and", "not", "the", "a", "an", "of", "in"]);
      const terms = raw
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOP.has(t));
      const needles = terms.length ? terms : [raw.trim()].filter(Boolean);

      const matches: Array<{ caseId: string; familyName: string; note: string }> = [];
      for (const [caseId, note] of NOTES) {
        const hay = note.toLowerCase();
        if (needles.some((n) => hay.includes(n))) {
          const c = CASES.find((x) => x.caseId === caseId);
          matches.push({ caseId, familyName: c?.familyName ?? "(unknown)", note });
        }
      }
      return { query: args.query, termsSearched: needles, matchCount: matches.length, matches };
    },
  },

  // --- Action tools (produce artifacts / change state, all LOCAL) --------
  {
    name: "flag_case",
    description:
      "Mark a case as priority and record the reason. Use when asked to flag, escalate, or prioritise a family. Returns a confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "e.g. 'C-0013'." },
        reason: { type: "string", description: "Short reason for prioritising this case." },
      },
      required: ["caseId", "reason"],
    },
    handler: (args) => {
      const c = CASES.find((x) => x.caseId === args.caseId);
      if (!c) return { ok: false, message: `No case found with id ${args.caseId}.` };
      c.priorityFlag = true;
      c.flagReason = args.reason;
      return {
        ok: true,
        caseId: c.caseId,
        familyName: c.familyName,
        priorityFlag: true,
        reason: args.reason,
        message: `${c.familyName} (${c.caseId}) flagged as priority.`,
      };
    },
  },
  {
    name: "generate_brief",
    description:
      "Compile a Markdown situation brief for the given caseIds, drawing on both the " +
      "structured records and the field notes, and write it to a local file. " +
      "Use when asked to draft/produce a brief, summary, or report. Returns the file path and a preview.",
    inputSchema: {
      type: "object",
      properties: {
        caseIds: {
          type: "array",
          items: { type: "string" },
          description: "The caseIds to include, e.g. ['C-0003','C-0013'].",
        },
        title: { type: "string", description: "A short title for the brief." },
      },
      required: ["caseIds", "title"],
    },
    handler: (args) => {
      reloadNotes();
      const ids: string[] = Array.isArray(args.caseIds) ? args.caseIds : [];
      const title: string = args.title || "Situation Brief";
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");

      let md = `# ${title}\n\n`;
      md += `_Generated locally by the Sovereign Aid Assistant on ${new Date().toISOString()}._\n`;
      md += `_Operational date for aid-gap calculations: ${DEMO_TODAY}._\n\n`;
      md += `Cases included: ${ids.length}\n\n---\n\n`;

      for (const id of ids) {
        const c = CASES.find((x) => x.caseId === id);
        if (!c) {
          md += `## ${id}\n\n_No record found for this case._\n\n`;
          continue;
        }
        const gap = aidGapDays(c);
        md += `## ${c.familyName} (${c.caseId})\n\n`;
        md += `- **Region:** ${c.region}\n`;
        md += `- **Household size:** ${c.householdSize}\n`;
        md += `- **Status:** ${c.status}${c.priorityFlag ? " · PRIORITY" : ""}\n`;
        md += `- **Aid type:** ${c.aidType}\n`;
        md += `- **Last aid:** ${c.lastAidDate ?? "never"} (${gap === Infinity ? "no aid on record" : `${gap} days ago`})\n`;
        if (c.flagReason) md += `- **Flag reason:** ${c.flagReason}\n`;
        const note = NOTES.get(id);
        if (note) {
          md += `\n**Field note:**\n\n`;
          md += note
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
          md += `\n`;
        }
        md += `\n---\n\n`;
      }

      if (!existsSync(BRIEFS_DIR)) mkdirSync(BRIEFS_DIR, { recursive: true });
      const filePath = join(BRIEFS_DIR, `${stamp}.md`);
      writeFileSync(filePath, md, "utf8");

      const preview = md.length > 800 ? md.slice(0, 800) + "\n…(truncated preview)" : md;
      return { ok: true, filePath, caseCount: ids.length, preview };
    },
  },
];

/** Look up a tool by name (used by the MCP server's call handler). */
export function getTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

/** Small summary used by startup logs / health checks. */
export function dataSummary() {
  return {
    caseCount: CASES.length,
    noteCount: NOTES.size,
    regions: Array.from(new Set(CASES.map((c) => c.region))).sort(),
    demoToday: DEMO_TODAY,
  };
}
