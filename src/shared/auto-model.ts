/** True for a selector that leaves the model to a router: llm-hub Smart Auto and the Copilot/Cursor `auto` models. */
export function isAutoSelector(id: string | null | undefined): boolean {
  return typeof id === "string" && /(^|[/-])smart-auto(-|$)|(^|-)auto$/.test(id);
}

/** The id without its provider path (`copilot/claude-opus-5-5` becomes `claude-opus-5-5`). */
function shortId(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1);
}

export const AUTO_UNKNOWN = "auto (model not reported)";

/**
 * How an auto chat names its model: `auto -> claude-opus-5-5` once a reply reported it,
 * `auto -> ~claude-opus-5-5` while it is only expected (a reply is running, the last one used it),
 * and `auto (model not reported)` when no reply named a model.
 */
export function autoLabel(modelUsed: string | null | undefined, expected = false): string {
  if (modelUsed === null || modelUsed === undefined || modelUsed === "") {
    return AUTO_UNKNOWN;
  }
  return `auto -> ${expected ? "~" : ""}${shortId(modelUsed)}`;
}
