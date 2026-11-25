// Closure gate: the facts that block a run from becoming `done`. Shared by `run finish` (every path that closes a
// run goes through it) and by the audit, so both judge a run the same way. Pure: reads a run state, writes nothing.

/** Node states that mean work is still pending. `ready` is derived by the projection; a stored node is `waiting` before it runs. */
const OPEN_STATES = ["waiting", "running", "ready"];

/** Why a run may not close, one string per problem. Empty when the run may close. */
export function closureProblems(run: { nodes?: unknown[] }): string[] {
  const nodes = (run.nodes ?? []) as Array<{ id?: unknown; status?: unknown }>;
  const problems: string[] = [];
  for (const n of nodes) {
    if (OPEN_STATES.includes(String(n.status))) problems.push(`node ${String(n.id)} is ${String(n.status)}`);
  }
  return problems;
}
