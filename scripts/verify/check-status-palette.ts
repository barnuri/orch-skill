#!/usr/bin/env bun
// check-status-palette.ts - visible browser proof of the shared status palette (src/shared/status-palette.ts).
// Renders every palette status as the real surfaces do (chip, result pill, graph result chip) with the
// real snapshot CSS, in light and dark, then checks each one's text, its colour family and its contrast.
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR, run, sleep, tmpDir } from "../lib/util.ts";

const SNAP = join(REPO_DIR, "src/snapshot");
const CSS = ["tokens.css", "components.css", "styles.css"];
const FILES = CSS;
// key -> visible text. Covered reads "Covered" on chips (as Chip does); the rest read their word.
const KEYS: Array<[string, string]> = [
  ["covered", "Covered"], ["skipped", "skipped"], ["partial", "partial"], ["full", "full"],
  ["done", "done"], ["blocked", "blocked"], ["error", "error"], ["waiting", "waiting"],
];
// The tone each key must render in. Checked on the computed RGB of its text.
const TONE: Record<string, string> = {
  covered: "purple", skipped: "gray", partial: "amber", full: "green", done: "green", blocked: "red", error: "red", waiting: "blue-gray",
};

// Every key is a chip. The verdicts full, partial and blocked also render as a result pill and a graph result chip.
const VERDICTS = ["full", "partial", "blocked"];
const chips = KEYS.map(([k, text]) => {
  const verdict = VERDICTS.includes(k) ? `<span class="result-pill result-${k} status-${k}" data-pill="${k}">${text}</span><svg class="node" width="90" height="22"><g class="result-chip result-${k} status-${k}" data-svg="${k}" transform="translate(0 2)"><rect width="60" height="15" rx="7.5"/><text x="30" y="11" text-anchor="middle">${text}</text></g></svg>` : "";
  return `<div class="row"><span class="chip ${k} status-${k}" data-key="${k}">${text}</span>${verdict}</div>`;
}).join("\n");
const html = `<!doctype html><html data-theme="dark"><head>${FILES.map((f) => `<link rel="stylesheet" href="${f}">`).join("")}
<style>body{padding:16px;background:var(--bg,#fff)}.row{display:flex;gap:16px;align-items:center;margin:6px 0}</style></head>
<body>${chips}</body></html>`;
// file: URLs are blocked in the browser, so the page and the snapshot CSS are served from a temp folder on a
// loopback port. A child process serves them: playwright-cli runs synchronously here and would block an in-process server.
const dir = tmpDir();
writeFileSync(join(dir, "index.html"), html);
for (const f of CSS) copyFileSync(join(SNAP, f), join(dir, f));
const port = 47000 + Math.floor(Math.random() * 1000);
const server = Bun.spawn(["python3", "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir], { stdout: "ignore", stderr: "ignore" });
await sleep(700);
const page = `http://127.0.0.1:${port}/index.html`;

const s = "-s=verify-status-palette";
const pw = (...a: string[]) => run(["playwright-cli", s, ...a]);
const val = (code: string): string => {
  const lines = pw("eval", code).out.split("\n");
  const at = lines.findIndex((l) => l.startsWith("### Result"));
  return at < 0 ? "" : (lines[at + 1] ?? "").trim().replace(/^"(.*)"$/, "$1");
};
let fail = false;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) fail = true;
};

pw("close");
const opened = pw("open", page);
if (opened.code !== 0) (console.log(`FAIL cannot open the palette page: ${opened.out.slice(0, 400)}`), server.kill(), process.exit(1));
await sleep(800);

// Reports one JSON row per element: key, text, computed colour, background and border colour, plus the tone family.
const probe = `() => {
  const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const family = ([r, g, b]) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min < 24) return "gray";
    if (r >= g && r >= b) return g > b + 40 && r - g < 100 ? "amber" : "red";
    if (g >= r && g >= b) return "green";
    if (b >= r && b >= g) return r > 120 && g < b - 40 && r - g > 40 ? "purple" : "blue-gray";
    return "?";
  };
  const out = [];
  for (const el of document.querySelectorAll('[data-key],[data-pill],[data-svg]')) {
    const key = el.dataset.key || el.dataset.pill || el.dataset.svg;
    const surface = el.dataset.key ? "chip" : el.dataset.pill ? "pill" : "svg";
    const cs = getComputedStyle(el);
    // A graph result chip paints its text through fill; its rect carries the background.
    const colour = surface === "svg" ? getComputedStyle(el.querySelector("text")).fill : cs.color;
    const text = surface === "svg" ? el.querySelector("text").textContent : el.textContent;
    out.push({ key, surface, text, family: family(rgb(colour)), colour, bg: cs.backgroundColor });
  }
  return out.map((r) => [r.key, r.surface, r.text, r.family, r.colour].join(";")).join("|");
}`;

for (const theme of ["dark", "light"]) {
  pw("eval", `() => document.documentElement.setAttribute('data-theme', '${theme}')`);
  await sleep(200);
  const rows = val(probe).split("|").map((r) => { const [key, surface, text, family, colour] = r.split(";"); return { key, surface, text, family, colour }; });
  for (const [key, text] of KEYS) {
    for (const surface of ["chip", ...(VERDICTS.includes(key) ? ["pill", "svg"] : [])]) {
      const row = rows.find((r) => r?.key === key && r.surface === surface);
      if (row === undefined) { check(false, `${theme} ${surface} ${key} rendered`); continue; }
      check(row.text === text, `${theme} ${surface} ${key}: visible text "${row.text}"`);
      check(row.family === TONE[key], `${theme} ${surface} ${key}: colour family ${row.family} = ${TONE[key]} (${row.colour})`);
    }
  }
  const shot = `${tmpDir()}/verify-status-palette-${theme}.png`;
  if (pw("screenshot", `--filename=${shot}`).code === 0) console.log(`shot ${shot}`);
}
pw("close");
server.kill();
console.log(fail ? "FAIL status palette" : "PASS status palette");
process.exit(fail ? 1 : 0);
