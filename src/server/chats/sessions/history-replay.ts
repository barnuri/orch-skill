import type { ReplayMessage } from "./types";

/** About 6k tokens of earlier conversation. */
export const REPLAY_CHAR_BUDGET = 24_000;

export interface Replay { prompt: string; truncated: boolean; included: number }

/**
 * Prepends the newest messages that fit `budget` characters to `prompt`, oldest dropped first.
 * A message that alone exceeds the room left is cut from its start so its tail survives. With no
 * history the prompt is returned unchanged.
 */
export function buildReplayPrompt(history: readonly ReplayMessage[], prompt: string, budget: number = REPLAY_CHAR_BUDGET): Replay {
  const usable = history.filter((m) => m.content.trim() !== "");
  const lines: string[] = [];
  let used = 0;
  let truncated = false;
  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i] as ReplayMessage;
    const label = m.role === "user" ? "User" : "Assistant";
    const room = budget - used - label.length - 4;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const text = m.content.length > room ? `…${m.content.slice(m.content.length - room + 1)}` : m.content;
    lines.unshift(`${label}: ${text}`);
    used += label.length + 4 + text.length;
    if (text.length < m.content.length) {
      truncated = true;
      break;
    }
  }
  if (lines.length === 0) {
    return { prompt, truncated, included: 0 };
  }
  const note = truncated ? "(Earlier messages were omitted.)\n" : "";
  return {
    prompt: `The conversation so far is below, for context. Reply only to the new message at the end.\n${note}\n<conversation>\n${lines.join("\n\n")}\n</conversation>\n\nNew message from the user:\n${prompt}`,
    truncated,
    included: lines.length,
  };
}
