/** Chat composer slash commands and skill suggestions. Bun-free: used by the server and the web. */

export interface SlashCommand {
  name: string;
  usage: string;
  description: string;
}

export interface SkillSuggestion {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "goal", usage: "/goal <objective>", description: "Keep working toward an objective until it is met" },
  { name: "loop", usage: "/loop <interval> <prompt>", description: "Repeat a prompt on an interval, for example /loop 10m check the build" },
  { name: "schedule", usage: "/schedule <when> <prompt>", description: "Run a prompt at a set time, for example /schedule every day at 09:00 summarise the news" },
  { name: "watch", usage: "/watch <url|path|command>", description: "Watch a URL, file or command and report changes" },
  { name: "schedules", usage: "/schedules", description: "List the schedules of this chat" },
  { name: "loops", usage: "/loops", description: "List the loops of this chat" },
  { name: "feedback", usage: "/feedback <text>", description: "Send feedback about orch" },
];

/**
 * Where the caret sits in a slash token.
 * `first`: the text starts with `/` and the caret is still in that first word. Commands, then skills.
 * `mid`: a `/` after whitespace starts a word the caret is in. Skills only.
 */
export interface SlashContext {
  mode: "first" | "mid";
  /** Index of the `/` that starts the token. */
  start: number;
  /** Text typed after the `/`, up to the caret. */
  query: string;
}

export function slashContext(text: string, caret: number): SlashContext | null {
  const before = text.slice(0, caret);
  const token = /(^|\s)\/(\S*)$/.exec(before);
  if (token === null) {
    return null;
  }
  const start = before.length - token[2]!.length - 1;
  return { mode: start === 0 ? "first" : "mid", start, query: token[2]! };
}

export type MenuRow =
  | { kind: "command"; name: string; usage: string; description: string }
  | { kind: "skill"; name: string; usage: string; description: string };

/** Commands whose name contains the query, prefix matches first. Skills match by name or description. */
export function filterMenu(ctx: SlashContext, skills: readonly SkillSuggestion[]): MenuRow[] {
  const q = ctx.query.toLowerCase();
  const rank = (name: string): number => (name.toLowerCase().startsWith(q) ? 0 : 1);
  const commands: MenuRow[] = SLASH_COMMANDS.filter((c) => c.name.includes(q))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((c) => ({ kind: "command", name: c.name, usage: c.usage, description: c.description }));
  const matchedSkills: MenuRow[] = skills
    .filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .map((s) => ({ kind: "skill", name: s.name, usage: `/${s.name}`, description: s.description }));
  return ctx.mode === "first" ? [...commands, ...matchedSkills] : matchedSkills;
}

/** Replaces the typed `/query` with `/name`, plus a space unless the text after the caret already starts with one. */
export function insertMenuItem(text: string, caret: number, ctx: SlashContext, name: string): { text: string; caret: number } {
  const after = text.slice(caret);
  const insert = /^\s/.test(after) ? `/${name}` : `/${name} `;
  return { text: text.slice(0, ctx.start) + insert + after, caret: ctx.start + insert.length };
}

export type MenuKey = "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape";

/** What a key does while the menu is open: move the highlight, pick, close, or nothing (not a menu key). */
export type MenuAction = { type: "move"; index: number } | { type: "pick"; index: number } | { type: "close" } | null;

export function menuAction(key: string, active: number, count: number): MenuAction {
  if (count === 0) {
    return null;
  }
  switch (key as MenuKey) {
    case "ArrowDown":
      return { type: "move", index: (active + 1) % count };
    case "ArrowUp":
      return { type: "move", index: (active - 1 + count) % count };
    case "Enter":
    case "Tab":
      return { type: "pick", index: active };
    case "Escape":
      return { type: "close" };
    default:
      return null;
  }
}
