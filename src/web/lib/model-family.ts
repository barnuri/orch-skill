import type { RunNode } from "../../shared/types/run-node";
import { modelPick } from "./model-pick";

export type ModelFamily = "claude" | "openai" | "gemini" | "qwen" | "llama" | "mistral" | "deepseek" | "local" | "fallback";

const RULES: [RegExp, ModelFamily][] = [
  [/claude|anthropic|opus|sonnet|haiku/, "claude"],
  [/gpt|openai|codex|(^|[-/_])o[134](-|$)/, "openai"],
  [/gemini|gemma/, "gemini"],
  [/qwen/, "qwen"],
  [/llama/, "llama"],
  [/mistral|mixtral|codestral/, "mistral"],
  [/deepseek/, "deepseek"],
  [/local|llama-swap|ollama/, "local"],
];

/** The family a model id belongs to, from its name; `fallback` when no rule matches. */
export function familyOf(model: string | null | undefined): ModelFamily {
  if (model === null || model === undefined || model === "") {
    return "fallback";
  }
  const name = model.toLowerCase();
  for (const [pattern, family] of RULES) {
    if (pattern.test(name)) {
      return family;
    }
  }
  return "fallback";
}

/** Smart Auto and auto profiles: the model is picked by the hub, so the icon follows the served model. */
export function isAutoNode(node: RunNode): boolean {
  const auto = /(^|\/)smart-auto(-|$)|(^|-)auto$/;
  if ([node.model, node.model_id, node.profile].some((value) => value !== null && value !== undefined && auto.test(value))) {
    return true;
  }
  return modelPick(node)?.isAuto === true;
}

/**
 * The model the icon describes: the served model (`actual_model`) for auto nodes, else the
 * configured model. Null when neither is known.
 */
export function iconModelOf(node: RunNode): string | null {
  const configured = node.model_id ?? node.model ?? null;
  if (isAutoNode(node)) {
    return node.actual_model ?? null;
  }
  return configured;
}

/** Smart Auto node only: role and tier are shown on it and nowhere else. */
export function showsRoleTier(node: RunNode): boolean {
  return isAutoNode(node) && /(^|\/)smart-auto(-|$)/.test(`${node.model ?? ""} ${node.model_id ?? ""} ${node.profile ?? ""}`);
}
