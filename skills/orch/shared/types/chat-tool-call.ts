export interface ChatToolCall {
  /** The tool's own name as the harness recorded it, e.g. `Bash`, `Edit`, `Read`. */
  name: string;
  /** A one-line precis of what it was called with — never the full input. */
  summary: string;
}
