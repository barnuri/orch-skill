import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ChatStore } from "./store";
import { migrateSubfoldersToSubprojects, type SubfolderMigration } from "./subprojects";

export interface MigrateResult { code: number; lines: string[]; backup: string | null; report: SubfolderMigration | null }

const USAGE = "usage: bun scripts/migrate-subprojects.ts [--home <dir>] [--dry-run] [--json]";

/**
 * The `migrate-subprojects` command: copies `<home>/chats.db` to `chats.db.bak-subprojects-<stamp>` (a consistent SQLite copy, taken
 * only when there is something to change), then moves every active chat with a subfolder into its own sub project. `--dry-run`
 * prints the plan and writes nothing. Home: `--home`, else `$HARNESS_ORCH_HOME`, else `~/.harness-orch`.
 */
export function migrateSubprojectsCommand(argv: string[], env: Record<string, string | undefined> = process.env, stamp: string = new Date().toISOString().replace(/[:.]/g, "-")): MigrateResult {
  let home = env["HARNESS_ORCH_HOME"] ?? join(homedir(), ".harness-orch");
  let dryRun = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--home" && argv[i + 1] !== undefined) {
      home = argv[i + 1] as string;
      i += 1;
    } else {
      return { code: 2, lines: [USAGE], backup: null, report: null };
    }
  }
  const db = join(home, "chats.db");
  if (!existsSync(db)) {
    return { code: 1, lines: [`no chat history at ${db}`], backup: null, report: null };
  }
  const store = new ChatStore(db);
  try {
    const plan = migrateSubfoldersToSubprojects(store, { dryRun: true });
    let backup: string | null = null;
    let report: SubfolderMigration = { ...plan, dry_run: dryRun };
    if (!dryRun && plan.migrated.length > 0) {
      backup = `${db}.bak-subprojects-${stamp}`;
      store.handle.query("VACUUM INTO ?").run(backup);
      report = migrateSubfoldersToSubprojects(store, { dryRun: false });
    }
    if (json) {
      return { code: 0, lines: [JSON.stringify({ ...report, backup })], backup, report };
    }
    const lines = [`${dryRun ? "dry run: would move" : "moved"} ${report.migrated.length} chat(s) into sub projects (${db})`];
    if (backup !== null) {
      lines.push(`backup: ${backup}`);
    }
    for (const m of report.migrated) {
      lines.push(`  ${m.chat_id} "${m.title}" -> ${m.created ? "new" : "existing"} sub project "${m.project_name}" (${m.project_id}) under ${m.parent_id}, folder ${m.path ?? "(none)"}`);
    }
    for (const s of report.skipped) {
      lines.push(`  skipped ${s.chat_id} (subfolder ${s.subfolder}): ${s.reason}`);
    }
    return { code: 0, lines, backup, report };
  } finally {
    store.close();
  }
}
