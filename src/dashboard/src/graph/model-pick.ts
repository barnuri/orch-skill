import type { RunNode } from "../../../shared/types/run-node";

/** The model a node ran on, as the graph and the details panel show it. */
export interface ModelPick {
  /** Full model id: the hub's pick when there is one, else the profile's model. */
  model: string;
  /** The id without its provider path (`copilot/claude-opus-5-5` → `claude-opus-5-5`). */
  short: string;
  /** True when Smart Auto chose the model, false when the profile names it. */
  isAuto: boolean;
  /** True when only the hub's pre-dispatch guess is known, not the model that served. */
  isExpected: boolean;
  tier: string | null;
  role: string | null;
  reason: string | null;
  /** The selector the profile asked for (`hub-smart-auto-balance`), when Smart Auto picked. */
  selector: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

export function shortModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

/**
 * Pick order: the model that served the latest solver stage, the hub's reported pick, the hub's
 * pre-dispatch guess, then the profile's model. Null when the node names no model at all.
 */
export function modelPick(node: RunNode): ModelPick | null {
  const configured = nonEmpty(node.model_id) ?? nonEmpty(node.model);
  const actual = nonEmpty(node.main_model) ?? nonEmpty(node.hub?.actual?.model);
  const expected = nonEmpty(node.hub?.expected?.model);
  const picked = actual ?? expected;
  if (picked === null) {
    return configured === null
      ? null
      : {
          model: configured,
          short: configured,
          isAuto: false,
          isExpected: false,
          tier: null,
          role: null,
          reason: null,
          selector: null,
        };
  }
  const hub = node.hub ?? null;
  return {
    model: picked,
    short: shortModel(picked),
    isAuto: true,
    isExpected: actual === null,
    tier: nonEmpty(hub?.actual?.tier) ?? nonEmpty(hub?.expected?.tier) ?? nonEmpty(node.tier),
    role: nonEmpty(hub?.actual?.role) ?? nonEmpty(hub?.expected?.role) ?? nonEmpty(node.role),
    reason: nonEmpty(hub?.actual?.reason) ?? nonEmpty(hub?.expected?.reason),
    selector: configured,
  };
}

/** The pick as one label: `claude-opus-5-5`, or `~claude-opus-5-5` while only expected. */
export function pickLabel(pick: ModelPick): string {
  return pick.isExpected ? `~${pick.short}` : pick.short;
}
