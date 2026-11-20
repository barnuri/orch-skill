#!/usr/bin/env bun
/**
 * Moves every active chat that has a subfolder into its own sub project (one per project and subfolder), after a backup of chats.db.
 * Usage: bun scripts/migrate-subprojects.ts [--home <dir>] [--dry-run] [--json]
 */
import { migrateSubprojectsCommand } from "../src/server/chats/subproject-migrate";

const result = migrateSubprojectsCommand(process.argv.slice(2));
for (const line of result.lines) {
  (result.code === 0 ? console.log : console.error)(line);
}
process.exit(result.code);
