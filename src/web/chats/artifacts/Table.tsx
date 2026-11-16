import { type ReactNode, useMemo } from "react";

const MAX_ROWS = 500;
const MAX_DEPTH = 8;

/** RFC 4180 parsing with quotes, doubled quotes and newlines inside a quoted cell. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") {
        i++;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function Node({ value, label, depth }: { value: unknown; label: string | null; depth: number }): ReactNode {
  const key = label === null ? null : <span className="art-key">{label}: </span>;
  if (typeof value !== "object" || value === null) {
    return <div className="art-leaf mono">{key}<span className={`art-val is-${value === null ? "null" : typeof value}`}>{JSON.stringify(value)}</span></div>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return (
    <details className="art-node mono" open={depth < 2}>
      <summary>{key}<span className="art-sum">{Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}</span></summary>
      {depth >= MAX_DEPTH ? <div className="art-leaf">…</div> : entries.map(([k, v]) => <Node key={k} value={v} label={k} depth={depth + 1} />)}
    </details>
  );
}

export default function Table({ text, kind, name }: { text: string; kind: "csv" | "json"; name: string }) {
  const parsed = useMemo(() => {
    if (kind === "json") {
      try {
        return { json: JSON.parse(text) as unknown };
      } catch (err) {
        return { error: err instanceof Error ? err.message : "invalid JSON" };
      }
    }
    return { rows: parseCsv(text, name.toLowerCase().endsWith(".tsv") ? "\t" : ",") };
  }, [text, kind, name]);
  if ("error" in parsed) {
    return <p className="art-note" role="status">Not valid JSON ({parsed.error}). Use the Code view.</p>;
  }
  if ("json" in parsed) {
    return <div className="art-tree" data-testid="art-tree"><Node value={parsed.json} label={null} depth={0} /></div>;
  }
  const [head = [], ...body] = parsed.rows;
  return (
    <div className="art-table-wrap" data-testid="art-table">
      <table className="art-table">
        <thead><tr>{head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        <tbody>{body.slice(0, MAX_ROWS).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
      {body.length > MAX_ROWS ? <p className="art-note">Showing the first {MAX_ROWS} of {body.length} rows.</p> : null}
    </div>
  );
}
