import type { RunNode } from "../../../shared/types/run-node";

export const UNOWNED_TITLE = "marked running, but nothing is recorded as doing the work";
export const AFTER_THE_FACT = "recorded after the fact";

export interface NodeFlags {
  stale: boolean;
  unowned: boolean;
  afterTheFact: boolean;
}

/** A running node with no owner and no job is unowned; `backfilled` means it was never seen running. */
export function nodeFlags(node: RunNode): NodeFlags {
  const owner = node.owner ?? "";
  const job = node.job_id ?? "";
  return {
    stale: node.status === "running" && node.stale === true,
    unowned: node.status === "running" && owner === "" && job === "",
    afterTheFact: node.backfilled === true && node.status !== "running",
  };
}

/** "agent ses_…" / "job job-123" / "coordinator", or null when nothing is recorded. */
export function ownerText(node: RunNode): string | null {
  const owner = node.owner ?? "";
  if (owner === "") {
    return null;
  }
  if (owner === "coordinator") {
    return "orchestrator";
  }
  if (owner.startsWith("ses_")) {
    return `agent ${owner}`;
  }
  return owner === node.job_id || owner.startsWith("job-") ? `job ${owner}` : owner;
}

/** The owner id cut to 12 characters, or null when no owner is recorded. */
export function ownerIdShort(node: RunNode): string | null {
  const id = node.owner_id || node.owner || "";
  if (id === "") {
    return null;
  }
  return id.length > 12 ? `${id.slice(0, 12)}...` : id;
}

/** The handoff row: null for runs older than the field, else present, or why it is not. */
export function handoffText(node: RunNode): { text: string; missing: boolean } | null {
  if (node.handoff_present === undefined || node.handoff_present === null) {
    return null;
  }
  if (node.handoff_present) {
    return { text: "handoff present", missing: false };
  }
  return node.status === "done" ? { text: "done without handoff", missing: true } : { text: "no handoff yet", missing: true };
}

export interface OwnerChip {
  cls: string;
  text: string;
  title: string;
}

export const FINISHED_BY_OWNER = "finished by owner, unreviewed";

/** A words-only chip for the owner's state; existing chip classes only. Null when there is nothing to say. */
export function ownerChip(node: RunNode): OwnerChip | null {
  if (node.status === "done" && node.unverified === true) {
    return { cls: "stale", text: FINISHED_BY_OWNER, title: "The owner stopped and said it was done. Nobody has reviewed the result." };
  }
  if (node.status === "error" && node.owner_state === "gone") {
    return { cls: "error", text: "owner gone", title: "The owner no longer exists" };
  }
  if (node.status === "running" && (node.owner_state === "unbound" || node.owner_state === "unknown")) {
    return { cls: "waiting", text: exactOwner(node), title: node.owner_reason ?? "owner_reason not recorded" };
  }
  if (node.status === "running" && (node.owner ?? "") === "" && (node.job_id ?? "") === "" && node.owner_state == null) {
    return { cls: "waiting", text: "no owner", title: "Nothing is recorded as doing the work" };
  }
  if (node.status !== "running" || (node.owner ?? "") === "" || node.owner === "coordinator") {
    return null;
  }
  if (node.owner_state === "alive") {
    return { cls: "running", text: "owner alive", title: "The owner is working" };
  }
  if (node.owner_state == null) {
    return { cls: "waiting", text: "owner not checked", title: "The owner has not been checked yet" };
  }
  return null;
}

/** The exact owner state and reason: `owner_state: <state>, owner_reason: <reason>`. The reason is omitted when none is recorded. */
export function exactOwner(node: RunNode): string {
  const reason = node.owner_reason ? `, owner_reason: ${node.owner_reason}` : "";
  return `owner_state: ${String(node.owner_state)}${reason}`;
}

/** The exact owner state for the status line and the table: `owner_state: <state>`, or "no owner" when nothing is recorded. */
export function ownerStateLabel(node: RunNode): string {
  if (node.owner_state != null) {
    return exactOwner(node);
  }
  return (node.owner ?? "") === "" && (node.job_id ?? "") === "" ? "no owner" : "owner not checked";
}

/**
 * The class of a card's health line. Stale, unowned and after-the-fact are warnings (amber, `flagged`);
 * an owner chip keeps its own tone, so a healthy "owner alive" is blue and "owner gone" red, never amber.
 */
export function healthClass(node: RunNode): string {
  const flags = nodeFlags(node);
  if (flags.stale || flags.unowned) {
    return "health flagged";
  }
  const chip = ownerChip(node);
  if (chip !== null) {
    return chip.cls === "stale" ? "health flagged" : `health ${chip.cls}`;
  }
  return flags.afterTheFact ? "health flagged" : "health";
}

/** Why a node is blocked on the user (`node update --needs-user`), or null when it is not. */
export function needsUserReason(node: RunNode): string | null {
  const reason = node.needs_user;
  return typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;
}

/** Why the coordinator holds a ready node back (`node update --hold`), or null when it does not. */
export function holdReason(node: RunNode): string | null {
  const reason = node.hold;
  return typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;
}

/** True when any node is done only because its owner said so. */
export function hasUnreviewed(nodes: readonly RunNode[]): boolean {
  return nodes.some((n) => n.status === "done" && n.unverified === true);
}

export interface ResultChip {
  /** full | partial | blocked | unknown */
  verdict: string;
  summary: string;
  followUp: string;
}

/** The recorded node result for a done node (`node result`), or null. A done node without one is "unknown". */
export function resultChip(node: RunNode): ResultChip | null {
  const r = node.result;
  if (r === undefined || r === null) {
    return node.status === "done" ? { verdict: "unknown", summary: "", followUp: "" } : null;
  }
  return { verdict: r.verdict, summary: r.summary, followUp: r.follow_up };
}
