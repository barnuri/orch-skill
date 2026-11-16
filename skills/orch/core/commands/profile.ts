// `orch profile list | show <name> | pick "<task>"` and `orch model list`. Ported from cmd_profile
// (lib/core/config.sh), cmd_profile_pick (lib/adapters/routing.sh) and cmd_model (lib/adapters/routing.sh).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import {
  PROFILE_PICK_USAGE,
  MODEL_LIST_USAGE,
  budgetCheck,
  modelListText,
  profilePick,
  readCatalog,
  setting,
  type Catalog,
} from "../adapters/routing.ts";

export const PROFILE_USAGE = "dispatch.sh profile list | show <name> | pick \"<task>\" [--complexity …] [--kind K] | sanity [--profile NAME] | unset-env <name> <VAR>...";

async function loadCatalog(home: string): Promise<Catalog> {
  return readCatalog(paths.profiles(home));
}

async function loadMemory(home: string): Promise<any[]> {
  const text = await readFile(join(home, "memory.json"), "utf8").catch(() => "");
  if (text === "") return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

function out(s: string): number {
  if (s !== "") process.stdout.write(s);
  return 0;
}

function err(s: string, code: number): number {
  process.stderr.write(s);
  return code;
}

// profile list: "*" marks the default profile. Insertion order, as jq to_entries.
export async function profileList(_args: string[]): Promise<number> {
  const cat = await loadCatalog(orchHome());
  const dflt = setting(cat, "default_profile", "");
  const lines = Object.entries(cat.profiles ?? {}).map(
    ([k, p]: [string, any]) => `${k === dflt ? "*" : ""}${k}\t${p.harness}\t${p.model ?? ""}\n`,
  );
  return out(lines.join(""));
}

// profile show <name> [--effective]: the profile as written in profiles.json (env values stay as written).
// --effective prints key, value and source (node, profile, defaults, builtin); same rule as profile_effective.
const BUILTIN_PROFILE_DEFAULTS: Record<string, unknown> = { parallel_ok: true, max_parallel: 15, flags: [], env: {} };
const EFFECTIVE_KEYS = ["parallel_ok", "max_parallel", "flags", "env", "timeout_min", "retry", "stall_min", "effort", "tier", "role", "cost", "quality", "speed", "risk"];
export async function profileShow(args: string[]): Promise<number> {
  const name = args[0] ?? "";
  if (name === "") return err("usage: dispatch.sh profile show <name> [--effective]\n", 2);
  const cat = await loadCatalog(orchHome());
  const prof = cat.profiles?.[name];
  if (!prof) {
    const avail = Object.keys(cat.profiles ?? {}).sort().join(", ");
    return err(`profile ${name}: unknown profile. Available: ${avail}\n`, 2);
  }
  if (args[1] === "--effective") {
    const d: Record<string, any> = (cat as any).defaults ?? {};
    const lines = EFFECTIVE_KEYS.map((k) => {
      let src = "builtin";
      let v: unknown = BUILTIN_PROFILE_DEFAULTS[k] ?? null;
      if (k === "env") {
        v = { ...(d.env ?? {}), ...(prof.env ?? {}) };
        src = prof.env !== undefined ? "profile" : d.env !== undefined ? "defaults" : "builtin";
      } else if (prof[k] !== undefined) { v = prof[k]; src = "profile"; }
      else if (d[k] !== undefined) { v = d[k]; src = "defaults"; }
      return `${k}\t${JSON.stringify(v)}\t${src}\n`;
    });
    return out(lines.join(""));
  }
  return out(JSON.stringify(prof, null, 2) + "\n");
}


// profile pick "<task>" [--complexity C] [--kind K]
export async function profilePickCommand(args: string[]): Promise<number> {
  let task = "";
  let complexity = "";
  let kind = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--complexity") complexity = args[++i] ?? "";
    else if (a === "--kind") kind = args[++i] ?? "";
    else if (a.startsWith("-")) return err(`profile pick: unknown option ${a}\n`, 2);
    else if (task === "") task = a;
  }
  if (task === "") return err(`usage: ${PROFILE_PICK_USAGE}\n`, 2);
  const home = orchHome();
  if (complexity === "") {
    const words = task.trim().split(/\s+/).filter((w) => w !== "").length;
    complexity = words <= 8 ? "small" : "medium";
  }
  const cat = await loadCatalog(home);
  const budgetOk = await budgetCheck(cat);
  const mem = await loadMemory(home);
  const lines = profilePick(cat, mem, complexity, kind, budgetOk);
  if (!lines) return err("profile pick: no profile available\n", 2);
  return out(lines.join("\n") + "\n");
}

// model list [--profile P] [--harness H]
export async function modelList(args: string[]): Promise<number> {
  let profile = "";
  let harness = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--profile") profile = args[++i] ?? "";
    else if (a === "--harness") harness = args[++i] ?? "";
    else return err(`model list: unknown argument ${a}\n`, 2);
  }
  const cat = await loadCatalog(orchHome());
  return out(modelListText(cat, profile, harness));
}
