import { join } from "node:path";

import { ensureSubfolder, normaliseSubfolder, reasonOf, SubfolderError, subfolderProblem } from "./subfolder";
import type { ChatStore } from "./store";
import type { ProjectRow } from "./types";

/** Why a sub project cannot go under `parent`, or null. Sub projects are one level deep and need an active parent. */
export function parentProblem(parent: ProjectRow): string | null {
  if (parent.parent_id !== null) {
    return "parent_id: a sub project cannot have sub projects";
  }
  if (parent.archived_at !== null) {
    return "parent_id: the parent project is archived";
  }
  return null;
}

/**
 * The folder of a new sub project that names no path: `<parent path>/<name>`, created when missing. Null when the parent has no
 * folder. Throws SubfolderError when the name is not one folder name or the folder resolves outside the parent's folder.
 */
export function subProjectFolder(parent: ProjectRow, name: string): string | null {
  if (parent.path === null) {
    return null;
  }
  const folder = normaliseSubfolder(name);
  if (folder === null || folder.includes("/")) {
    throw new SubfolderError("subfolder: a sub project name without a path must be one folder name (no /)");
  }
  ensureSubfolder(parent.path, folder);
  return join(parent.path, folder);
}

export interface MigratedChat {
  chat_id: string; title: string; subfolder: string; parent_id: string; project_id: string; project_name: string; path: string | null; created: boolean;
}

export interface SkippedChat { chat_id: string; subfolder: string; reason: string }

export interface SubfolderMigration { dry_run: boolean; migrated: MigratedChat[]; skipped: SkippedChat[] }

/**
 * Turns every active chat that has a subfolder into a chat of a sub project: the sub project sits under the chat's project (under
 * that project's parent when the chat's project is itself a sub project), is named after the subfolder and runs in
 * `<project path>/<subfolder>`, the folder the chat ran in before. Chats with the same project and subfolder share one sub
 * project. The chat keeps its id, history and session; only `project_id` changes and `subfolder` is cleared. A second run finds no
 * chat with a subfolder, or reuses the sub project with the same parent and path, so it is safe to repeat. `dryRun` writes nothing.
 */
export function migrateSubfoldersToSubprojects(store: ChatStore, opts: { dryRun: boolean }): SubfolderMigration {
  const out: SubfolderMigration = { dry_run: opts.dryRun, migrated: [], skipped: [] };
  const planned = new Map<string, { id: string; name: string }>();
  store.transaction(() => {
    for (const chat of store.chatsWithSubfolder()) {
      const subfolder = chat.subfolder as string;
      const own = chat.project_id === null ? null : store.getProject(chat.project_id);
      if (own === null) {
        out.skipped.push({ chat_id: chat.id, subfolder, reason: "the chat has no project" });
        continue;
      }
      const parent = own.parent_id === null ? own : store.getProject(own.parent_id);
      if (parent === null) {
        out.skipped.push({ chat_id: chat.id, subfolder, reason: "the chat's project has a missing parent" });
        continue;
      }
      const problem = own.path === null ? null : subfolderProblem(own.path, subfolder);
      if (problem !== null) {
        out.skipped.push({ chat_id: chat.id, subfolder, reason: problem });
        continue;
      }
      const path = own.path === null ? null : join(own.path, subfolder);
      const key = `${parent.id}\0${path ?? `name:${subfolder}`}`;
      const existing = planned.get(key) ?? store.subProjects(parent.id).find((p) => p.archived_at === null && (path === null ? p.path === null && p.name === subfolder : p.path === path));
      let target = existing === undefined ? null : { id: existing.id, name: existing.name };
      const created = target === null;
      if (!opts.dryRun) {
        if (own.path !== null) {
          try {
            ensureSubfolder(own.path, subfolder);
          } catch (err) {
            if (err instanceof SubfolderError) {
              out.skipped.push({ chat_id: chat.id, subfolder, reason: reasonOf(err) });
              continue;
            }
            throw err;
          }
        }
        if (target === null) {
          const row = store.createProject({ name: subfolder, path, parent_id: parent.id });
          target = { id: row.id, name: row.name };
        }
        store.moveChatClearingSubfolder(chat.id, target.id);
      }
      target ??= { id: "(new)", name: subfolder };
      planned.set(key, target);
      out.migrated.push({ chat_id: chat.id, title: chat.title, subfolder, parent_id: parent.id, project_id: target.id, project_name: target.name, path, created });
    }
  });
  return out;
}
