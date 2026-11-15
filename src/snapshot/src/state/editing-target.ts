// What the document editor is working on: nothing, a not-yet-saved entry, a profile name
// (profiles.json) or an array index (memory.json). `"new"` is spelled out for readability
// even though the union already admits it as a string.
export type EditingTarget = null | "new" | string | number;
