// Harness registry and live availability probes. Ported from lib/adapters/harness.sh. Bun built-ins only.
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { OrchLock } from "../state/lock.ts";
import { readCatalog } from "./routing.ts";
import { profilesCommit } from "../state/profiles.ts";
import { USAGE_CHOICES, harnessUsage, usageFromChoice, type Use, type UsageChoice } from "../../../../src/shared/profile-usage.ts";

export const HARNESS_LIST_USAGE = "dispatch.ts harness list [--json] | set-usage <id> chat|runs|both";
const HARNESS_SET_USAGE_USAGE = "dispatch.ts harness set-usage <id> chat|runs|both";
const HARNESS_IDS = "claude cursor-agent opencode local-llm copilot pi".split(" ");
const DETECTED_CLI_IDS = "codex aider gemini".split(" ");
type Env = Record<string, string | undefined>;

export function harnessBinDirs(e: Env = process.env): string[] {
  if (e.ORCH_BIN_DIRS !== undefined) return e.ORCH_BIN_DIRS.split(":");
  const h = e.HOME ?? homedir();
  return [`${h}/.local/bin`, `${h}/bin`, `${h}/.cargo/bin`, `${h}/.bun/bin`, `${h}/.opencode/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
}

function isExec(f: string): boolean {
  try {
    accessSync(f, constants.X_OK);
    return statSync(f).isFile();
  } catch {
    return false;
  }
}

// PATH first, then the common install dirs (a supervisor starts with a minimal PATH).
export function harnessFindBinary(name: string, e: Env = process.env): string | null {
  for (const d of (e.PATH ?? "").split(":")) if (d !== "" && isExec(join(d, name))) return join(d, name);
  for (const d of harnessBinDirs(e)) if (d !== "" && isExec(join(d, name))) return join(d, name);
  return null;
}

const META: Record<string, { kind: string; binary: string | null; wired: boolean; description: string; needs: string[] }> = {
  claude: { kind: "cli", binary: "claude", wired: true, description: "Anthropic Claude Code CLI (headless -p).", needs: [] },
  "cursor-agent": { kind: "cli", binary: "cursor-agent", wired: true, description: "Cursor agent CLI for in-editor tasks.", needs: ["CURSOR_API_KEY on profile"] },
  opencode: { kind: "cli", binary: "opencode", wired: true, description: "OpenCode CLI agent loop.", needs: [] },
  "local-llm": { kind: "http", binary: null, wired: true, description: "OpenAI-compatible HTTP chat API via curl.", needs: ["LLM_HUB_URL"] },
  copilot: { kind: "cli", binary: "copilot", wired: true, description: "GitHub Copilot CLI (headless -p).", needs: [] },
  pi: { kind: "cli", binary: "pi", wired: true, description: "pi coding agent CLI, headless against llm-hub.", needs: ["LLM_HUB_URL"] },
  codex: { kind: "cli", binary: "codex", wired: false, description: "OpenAI Codex CLI.", needs: [] },
  aider: { kind: "cli", binary: "aider", wired: false, description: "Aider pair-programming CLI.", needs: [] },
  gemini: { kind: "cli", binary: "gemini", wired: false, description: "Google Gemini CLI.", needs: [] },
};

const HINTS: Record<string, string> = {
  claude: "install the claude CLI (often ~/.local/bin/claude)",
  "cursor-agent": "install cursor-agent (often ~/.local/bin/cursor-agent)",
  opencode: "install opencode and ensure it is on PATH",
  copilot: "install the GitHub Copilot CLI (often ~/.local/bin/copilot)",
  pi: "install the pi coding agent CLI (often ~/.bun/bin/pi)",
  codex: "install the codex CLI — not wired as an orch adapter yet",
  aider: "install aider — not wired as an orch adapter yet",
  gemini: "install the gemini CLI — not wired as an orch adapter yet",
  "local-llm": "set LLM_HUB_URL to an OpenAI-compatible /chat/completions base URL",
};

function probeAvailable(id: string, e: Env): boolean {
  if (id === "local-llm") return !!e.LLM_HUB_URL;
  return id in META ? harnessFindBinary(id, e) !== null : false;
}

export async function harnessListJson(e: Env = process.env): Promise<any> {
  const cat = await readCatalog(paths.profiles(orchHome())).catch(() => ({}) as any);
  const disabled: string[] = cat.settings?.disabled_harnesses ?? [];
  const ids = [...HARNESS_IDS, ...DETECTED_CLI_IDS];
  return {
    probed_at: nowIso(),
    harnesses: ids.map((id) => {
      const m = META[id]!;
      const available = probeAvailable(id, e);
      return {
        id,
        kind: m.kind,
        binary: m.binary,
        wired: m.wired,
        description: m.description,
        needs: m.needs,
        enabled: m.wired ? !disabled.includes(id) : true,
        usage: harnessUsage(cat, id),
        available,
        reason: available ? "" : (HINTS[id] ?? "unknown harness"),
      };
    }),
  };
}

// harness list is slow in bash (it probes every CLI), so one at a time; a caller that arrives meanwhile
// gets the last finished answer, or exit 75 when there is none.
export async function harnessList(args: string[]): Promise<number> {
  let json = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else return (process.stderr.write(`harness list: unknown argument ${a}\n`), 2);
  }
  const home = orchHome();
  const lastFile = join(paths.locks(home), "harness-list.last");
  const lock = new OrchLock(home, "harness-list");
  if (!(await lock.acquire())) {
    const last = await Bun.file(lastFile).text().catch(() => "");
    if (last !== "") return (process.stdout.write(last), 0);
    return (process.stderr.write("harness list: another probe is running\n"), 75);
  }
  try {
    const data = await harnessListJson();
    const text = json
      ? JSON.stringify(data, null, 2) + "\n"
      : data.harnesses.map((h: any) => [h.id, h.kind, h.available ? "ok" : "missing", h.enabled ? "on" : "off"].join("\t") + "\n").join("");
    await Bun.write(lastFile, text);
    process.stdout.write(text);
    return 0;
  } finally {
    await lock.release();
  }
}

export async function harnessSetUsage(args: string[]): Promise<number> {
  const [id = "", choice = ""] = args;
  if (id === "" || !(USAGE_CHOICES as readonly string[]).includes(choice)) return (process.stderr.write(`usage: ${HARNESS_SET_USAGE_USAGE}\n`), 2);
  if (!HARNESS_IDS.includes(id)) return (process.stderr.write(`harness ${id}: unknown harness. Available: ${HARNESS_IDS.join(", ")}\n`), 2);
  const home = orchHome();
  const file = paths.profiles(home);
  const doc: any = await Bun.file(file).json();
  doc.settings ??= {};
  const map: Record<string, Use[]> = { ...(doc.settings.harness_usage ?? {}) };
  if (choice === "both") delete map[id];
  else map[id] = usageFromChoice(choice as UsageChoice);
  if (Object.keys(map).length === 0) delete doc.settings.harness_usage;
  else doc.settings.harness_usage = map;
  profilesCommit(home, doc);
  process.stdout.write(`harness ${id}: usage = ${choice}\n`);
  return 0;
}

export async function cmdHarness(args: string[]): Promise<number> {
  if (args[0] === "list") return harnessList(args.slice(1));
  if (args[0] === "set-usage") return harnessSetUsage(args.slice(1));
  process.stderr.write(`usage: ${HARNESS_LIST_USAGE}\n`);
  return 2;
}
