import type { Project } from "./chat-types";

export interface ProjectNode { project: Project; depth: 0 | 1 }

/**
 * Projects in display order: each top-level project followed by its sub projects (oldest first). A sub project whose parent is
 * not in the list (archived, or on another page) shows as top level, so it is never lost.
 */
export function projectTree(projects: readonly Project[]): ProjectNode[] {
  const known = new Set(projects.map((p) => p.id));
  const children = new Map<string, Project[]>();
  for (const p of projects) {
    if (p.parent_id != null && known.has(p.parent_id)) {
      children.set(p.parent_id, [...(children.get(p.parent_id) ?? []), p]);
    }
  }
  const out: ProjectNode[] = [];
  for (const p of projects) {
    if (p.parent_id != null && known.has(p.parent_id)) {
      continue;
    }
    out.push({ project: p, depth: 0 });
    for (const child of [...(children.get(p.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
      out.push({ project: child, depth: 1 });
    }
  }
  return out;
}

/** `Parent / Sub` for a sub project whose parent is known, else the project's name. */
export function projectLabel(project: Project, projects: readonly Project[]): string {
  const parent = project.parent_id == null ? undefined : projects.find((p) => p.id === project.parent_id);
  return parent === undefined ? project.name : `${parent.name} / ${project.name}`;
}

/** Select options for a project picker: tree order, sub projects labelled `Parent / Sub`. */
export function projectOptions(projects: readonly Project[]): { value: string; label: string }[] {
  return projectTree(projects).map(({ project }) => ({ value: project.id, label: projectLabel(project, projects) }));
}
