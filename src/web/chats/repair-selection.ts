import { harnessUsable, normalizeSelection, type Selection } from "../lib/chat-logic";
import type { ChatOptions } from "../lib/chat-types";

/**
 * The selection to store when a chat's own harness is usable but its stored profile or model is not (unknown, disabled,
 * or removed from the profile's list). The pickers already show the normalized choice and lock it when it is the only one,
 * so without this the chat keeps the bad value and every send fails with no way to switch. Returns null when nothing needs
 * fixing, or when the harness itself is the problem (that stays visible so the user picks another one).
 */
export function repairSelection(options: ChatOptions, stored: Selection): Selection | null {
  const harness = options.harnesses.find((h) => h.id === stored.harness);
  if (harness === undefined || !harnessUsable(harness)) {
    return null;
  }
  const fixed = normalizeSelection(options, stored);
  if (fixed.harness !== stored.harness || fixed.profile === "") {
    return null;
  }
  const profileChanged = fixed.profile !== stored.profile;
  // A null model means "the profile's default": only an explicit model the profile no longer allows needs replacing.
  const modelChanged = stored.model !== null && fixed.model !== stored.model;
  return profileChanged || modelChanged ? fixed : null;
}
