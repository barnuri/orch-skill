import type { ProfilesDocument } from "../../../shared/types/profiles-document";
import { deepCopy } from "../forms/field-issues";

export type SwitchDecision =
  | { kind: "dirty" }
  | { kind: "missing" }
  | { kind: "ready"; document: ProfilesDocument };

export function profileSwitchDecision(loaded: ProfilesDocument, name: string, dirty: boolean): SwitchDecision {
  if (dirty) {
    return { kind: "dirty" };
  }
  const current = loaded.profiles[name];
  if (current === undefined) {
    return { kind: "missing" };
  }
  const next = deepCopy(loaded);
  const profile = next.profiles[name];
  if (profile === undefined) {
    return { kind: "missing" };
  }
  profile.enabled = current.enabled === false;
  return { kind: "ready", document: next };
}
