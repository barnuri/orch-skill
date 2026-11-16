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
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd: REPO_DIR, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: o + e };
}

const CACHE = join(tmpDir(), "orch-typecheck-cache");

function inputsHash(): string {
  const r = run(["git", "ls-files", "-c", "-o", "--exclude-standard", "--", "src", "skills/orch/core", "tsconfig.json", "package.json", "bun.lock", "scripts/typecheck.ts"], { cwd: REPO_DIR });
  const h = createHash("sha1");
  h.update(`${process.version}|${BUN_VER}\n`);
  for (const f of r.out.split("\n").filter(Boolean).sort()) {
    try {
      const st = statSync(join(REPO_DIR, f));
      h.update(`${f}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
    } catch {}
  }
  return h.digest("hex");
}

const BUN_VER = Bun.version;

async function bundleDashboard(): Promise<{ code: number; out: string }> {
  const out = mkdtempSync(join(tmpDir(), "orch-typecheck-"));
  try {
    const rs = await Promise.all(
      (["snapshot", "web"] as const).map((dir) => sh([BUN, "build", join(REPO_DIR, `src/${dir}/index.html`), "--outdir", join(out, dir), "--target=browser"])),
    );
    return rs.find((r) => r.code !== 0) ?? rs[0]!;
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

const tscArgs = (tsc: string, project: string, name: string): string[] => [tsc, "-p", project, "--noEmit", "--incremental", "--tsBuildInfoFile", join(CACHE, `${name}.tsbuildinfo`)];

/** code 2 = skip. */
async function serverTypecheck(tsc: string): Promise<{ code: number; out: string }> {
  const bt = bunTypesDir();
  if (!bt) return { code: 2, out: "" };
  const localNode = join(REPO_DIR, "node_modules/@types/node");
  const nt = existsSync(localNode) ? localNode : newestDir(join(BUN_CACHE, "@types"), "node@");
  if (!nt) return { code: 2, out: "" };
  mkdirSync(TYPES_DIR, { recursive: true });
  link(bt, "bun-types");
  link(nt, "node");
  return sh(tscArgs(tsc, join(REPO_DIR, "tsconfig.json"), "root"));
}

async function main(): Promise<number> {
  if (!which(BUN)) {
    console.log("SKIP: bun not found");
    return 0;
  }
  mkdirSync(CACHE, { recursive: true });
  const hash = inputsHash();
  const stamp = join(CACHE, "ok.hash");
  if (!process.argv.includes("--no-cache") && existsSync(stamp) && readFileSync(stamp, "utf8") === hash) {
    console.log("typecheck: ok (cached)");
    return 0;
  }
  const tsc = findTsc();
  if (!tsc) {
    console.log("SKIP: tsc not found (bun install, or brew install typescript)");
    return 0;
  }
  const [bundle, snap, server] = await Promise.all([
    bundleDashboard(),
    sh(tscArgs(tsc, join(REPO_DIR, "src/snapshot/tsconfig.json"), "snapshot")),
    serverTypecheck(tsc),
  ]);
  if (bundle.code !== 0) {
    process.stdout.write(bundle.out);
    console.error("typecheck: FAIL dashboard bundle");
    return 1;
  }
  if (snap.code !== 0) {
    process.stdout.write(snap.out);
    console.error("typecheck: FAIL dashboard tsc");
    return 1;
  }
  if (server.code === 2) {
    console.log("SKIP: server typecheck (bun-types/@types/node not in the bun cache; run 'bun add -g @types/bun' once to enable)");
    return 0;
  }
  if (server.code !== 0) {
    process.stdout.write(server.out);
    console.error("typecheck: FAIL server tsc");
    return 1;
  }
  writeFileSync(stamp, hash);
  console.log("typecheck: ok");
  return 0;
}

process.exit(await main());
