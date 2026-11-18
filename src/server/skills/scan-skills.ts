import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { SkillSuggestion } from "../../shared/slash-commands";

/** Only the front matter is read: a SKILL.md larger than this is cut before its closing `---`. */
const FRONT_MATTER_BYTES = 4096;

/** The skill folders the server can read, in priority order: the first folder that has a name wins. */
export function skillRoots(): string[] {
  const home = homedir();
  return [join(home, ".claude", "skills"), join(home, ".agents", "skills"), join(home, ".config", "opencode", "skills"), resolve(import.meta.dir, "../../../skills")];
}

/** Reads `name` and `description` from the YAML front matter. Folded (`>`) and literal (`|`) descriptions are joined. */
export function parseFrontMatter(text: string): { name: string | null; description: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { name: null, description: "" };
  }
  const end = lines.indexOf("---", 1);
  const body = end === -1 ? lines.slice(1) : lines.slice(1, end);
  let name: string | null = null;
  let description = "";
  for (let i = 0; i < body.length; i += 1) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(body[i]!);
    if (m === null) {
      continue;
    }
    const key = m[1]!;
    const raw = m[2]!.trim();
    if (key === "name") {
      name = unquote(raw);
    } else if (key === "description") {
      if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
        const parts: string[] = [];
        while (i + 1 < body.length && /^\s+\S/.test(body[i + 1]!)) {
          i += 1;
          parts.push(body[i]!.trim());
        }
        description = parts.join(" ");
      } else {
        description = unquote(raw);
      }
    }
  }
  return { name, description };
}

function unquote(value: string): string {
  const m = /^(["'])(.*)\1$/.exec(value);
  return m === null ? value : m[2]!;
}

async function readFrontMatter(file: string): Promise<string> {
  const handle = Bun.file(file);
  return handle.slice(0, FRONT_MATTER_BYTES).text();
}

/** Every skill folder (one with a SKILL.md) under the roots, deduplicated by name, sorted by name. Unreadable roots are skipped. */
export async function scanSkills(roots: readonly string[] = skillRoots()): Promise<SkillSuggestion[]> {
  const byName = new Map<string, SkillSuggestion>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const file = join(root, entry, "SKILL.md");
      try {
        if (!(await stat(file)).isFile()) {
          continue;
        }
        const meta = parseFrontMatter(await readFrontMatter(file));
        const name = meta.name ?? entry;
        if (!byName.has(name)) {
          byName.set(name, { name, description: meta.description });
        }
      } catch {
        continue;
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
