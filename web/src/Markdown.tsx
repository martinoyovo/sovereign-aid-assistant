import type { JSX } from "react";

/**
 * Dependency-free Markdown renderer (no external library, so nothing is fetched
 * at runtime). Handles the subset the app produces: headings, italic lines,
 * horizontal rules, blockquotes, bullet lists, GitHub-style tables, and inline
 * **bold**. It also linkifies caseIds (e.g. C-0003) into clickable spans when an
 * onCaseClick handler is supplied - that is what turns an answer's citations
 * into links back to their source data.
 */
export function Markdown({
  text,
  onCaseClick,
}: {
  text: string;
  onCaseClick?: (caseId: string) => void;
}) {
  return <div className="md">{renderBlocks(text, onCaseClick)}</div>;
}

function renderBlocks(text: string, onCaseClick?: (id: string) => void): JSX.Element[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: JSX.Element[] = [];
  let bullets: string[] = [];

  const flushBullets = () => {
    if (!bullets.length) return;
    const items = bullets.slice();
    bullets = [];
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {items.map((b, i) => (
          <li key={i}>{renderInline(b, onCaseClick)}</li>
        ))}
      </ul>,
    );
  };

  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isDivider = (l: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");
  const cells = (l: string) =>
    l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    // Tables
    if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      flushBullets();
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      i--;
      blocks.push(
        <table key={`t-${blocks.length}`} className="md-table">
          <thead>
            <tr>{header.map((h, j) => <th key={j}>{renderInline(h, onCaseClick)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, onCaseClick)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    // Blockquote (one or more consecutive "> " lines)
    if (/^\s*>/.test(line)) {
      flushBullets();
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      i--;
      blocks.push(
        <blockquote key={`bq-${blocks.length}`} className="md-quote">
          {renderBlocks(inner.join("\n"), onCaseClick)}
        </blockquote>,
      );
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      flushBullets();
      blocks.push(<hr key={`hr-${blocks.length}`} className="md-hr" />);
      continue;
    }

    // Headings
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushBullets();
      const level = heading[1].length;
      const Tag = (`h${Math.min(level + 1, 6)}`) as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={`h-${blocks.length}`} className="md-h">{renderInline(heading[2], onCaseClick)}</Tag>);
      continue;
    }

    // Whole-line italic (e.g. _Generated locally..._) - kept line-level so we
    // never mangle underscores inside file paths like un_osw.
    if (/^_.+_$/.test(trimmed)) {
      flushBullets();
      blocks.push(
        <p key={`i-${blocks.length}`} className="md-em">
          {renderInline(trimmed.slice(1, -1), onCaseClick)}
        </p>,
      );
      continue;
    }

    // Bullets
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      continue;
    }

    if (trimmed === "") {
      flushBullets();
    } else {
      flushBullets();
      blocks.push(<p key={`p-${blocks.length}`}>{renderInline(line, onCaseClick)}</p>);
    }
  }
  flushBullets();
  return blocks;
}

/** Inline: **bold** spans + clickable caseId citations. */
function renderInline(text: string, onCaseClick?: (id: string) => void): JSX.Element[] {
  // First split on bold, then linkify caseIds within each non-bold part.
  const out: JSX.Element[] = [];
  const boldParts = text.split(/(\*\*[^*]+\*\*)/g);
  let key = 0;
  for (const part of boldParts) {
    if (part.startsWith("**") && part.endsWith("**")) {
      out.push(<strong key={key++}>{part.slice(2, -2)}</strong>);
    } else {
      for (const node of linkifyCases(part, onCaseClick, () => key++)) out.push(node);
    }
  }
  return out;
}

function linkifyCases(
  text: string,
  onCaseClick: ((id: string) => void) | undefined,
  nextKey: () => number,
): JSX.Element[] {
  const parts = text.split(/(C-\d{4})/g);
  return parts.map((p) => {
    if (/^C-\d{4}$/.test(p) && onCaseClick) {
      return (
        <button key={nextKey()} className="case-link" onClick={() => onCaseClick(p)} title={`View ${p}`}>
          {p}
        </button>
      );
    }
    return <span key={nextKey()}>{p}</span>;
  });
}
