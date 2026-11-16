#!/usr/bin/env bun
// Typechecks the orch TypeScript tree without installing a single dependency.
//
//   1. Bun bundles the dashboard and the React app in src/web (transpile only: catches syntax and
//      unresolvable-import errors, needs nothing but bun).
//   2. tsc against src/snapshot/tsconfig.json: the zero-dep half of the tree (DOM lib, `types: []`),
//      which also proves shared/types stays Bun-free.
//   3. tsc against the root tsconfig.json: server + shared + dashboard tests. That one needs bun-types and
//      @types/node, from node_modules or bun's global install cache; they are symlinked into the
//      gitignored .types/ so `typeRoots` resolves.
//
// tsc is TypeScript 7 (the native compiler) when found: node_modules/.bin, then bun's cache, then PATH.
// A missing tool is a SKIP (exit 0), never a failure. Exit 0 = passed or skipped, 1 = a step failed.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME, REPO_DIR, run, tmpDir, which } from "./lib/util.ts";

const BUN = process.env["ORCH_BUN"] || process.execPath;
const BUN_CACHE = join(process.env["BUN_INSTALL"] ?? join(HOME, ".bun"), "install/cache");
const TYPES_DIR = join(REPO_DIR, ".types");

function newestDir(parent: string, prefix: string): string | null {
  if (!existsSync(parent)) return null;
  let best: string | null = null;
  let bestT = 0;
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const p = join(parent, name);
    const st = statSync(p);
    if (st.isDirectory() && st.mtimeMs >= bestT) {
      best = p;
      bestT = st.mtimeMs;
    }
  }
  return best;
}

function bundleDashboard(): boolean {
  const out = mkdtempSync(join(tmpDir(), "orch-typecheck-"));
  try {
    for (const [html, dir] of [["src/snapshot/index.html", "snapshot"], ["src/web/index.html", "web"]] as const) {
      const r = run([BUN, "build", join(REPO_DIR, html), "--outdir", join(out, dir), "--target=browser"]);
      if (r.code !== 0) return false;
    }
    return true;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function findTsc(): string | null {
  const local = join(REPO_DIR, "node_modules/.bin/tsc");
  if (existsSync(local)) return local;
  const cached = newestDir(join(BUN_CACHE), "typescript@7.");
  if (cached && existsSync(join(cached, "bin/tsc"))) return join(cached, "bin/tsc");
  return which("tsc");
}

function bunTypesDir(): string | null {
  const override = process.env["ORCH_BUN_TYPES"];
  if (override) return existsSync(override) ? override : null;
  const local = join(REPO_DIR, "node_modules/bun-types");
  if (existsSync(local)) return local;
  const v = run([BUN, "--version"]);
  if (v.code !== 0) return null;
  return newestDir(BUN_CACHE, `bun-types@${v.out.trim()}`);
}

function link(target: string, name: string): void {
  const l = join(TYPES_DIR, name);
  rmSync(l, { force: true });
  symlinkSync(target, l);
}

/** 0 ok, 1 failed, 2 skip. */
function serverTypecheck(tsc: string): number {
  const bt = bunTypesDir();
  if (!bt) return 2;
  const localNode = join(REPO_DIR, "node_modules/@types/node");
  const nt = existsSync(localNode) ? localNode : newestDir(join(BUN_CACHE, "@types"), "node@");
  if (!nt) return 2;
  mkdirSync(TYPES_DIR, { recursive: true });
  link(bt, "bun-types");
  link(nt, "node");
  return run([tsc, "-p", join(REPO_DIR, "tsconfig.json"), "--noEmit"]).code === 0 ? 0 : 1;
}

function tscShow(tsc: string, project: string): boolean {
  const r = run([tsc, "-p", project, "--noEmit"]);
  if (r.code !== 0) process.stdout.write(r.out + r.err);
  return r.code === 0;
}

function main(): number {
  if (!which(BUN)) {
    console.log("SKIP: bun not found");
    return 0;
  }
  if (!bundleDashboard()) {
    console.error("typecheck: FAIL dashboard bundle");
    return 1;
  }
  const tsc = findTsc();
  if (!tsc) {
    console.log("SKIP: tsc not found (bun install, or brew install typescript)");
    return 0;
  }
  if (!tscShow(tsc, join(REPO_DIR, "src/snapshot/tsconfig.json"))) {
    console.error("typecheck: FAIL dashboard tsc");
    return 1;
  }
  const rc = serverTypecheck(tsc);
  if (rc === 2) {
    console.log("SKIP: server typecheck (bun-types/@types/node not in the bun cache; run 'bun add -g @types/bun' once to enable)");
    return 0;
  }
  if (rc !== 0) {
    const r = run([tsc, "-p", join(REPO_DIR, "tsconfig.json"), "--noEmit"]);
    process.stdout.write(r.out + r.err);
    console.error("typecheck: FAIL server tsc");
    return 1;
  }
  console.log("typecheck: ok");
  return 0;
}

process.exit(main());
