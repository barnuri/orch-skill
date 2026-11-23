// Dev-lane shim, loaded before the app. The Stage-3 decorator helpers in @barnuri/zod-decorators read
// Symbol.metadata; the Bun production bundle provides it, the browser in the Vite lane does not.
if (!("metadata" in Symbol)) {
  Object.defineProperty(Symbol, "metadata", { value: Symbol("Symbol.metadata") });
}
