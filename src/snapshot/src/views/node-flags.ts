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
    return "coordinator";
  }
  if (owner.startsWith("ses_")) {
    return `agent ${owner}`;
  }
  return owner === node.job_id || owner.startsWith("job-") ? `job ${owner}` : owner;
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
  if (node.status !== "running" || (node.owner ?? "") === "" || node.owner === "coordinator") {
    return null;
  }
  if (node.owner_state === "alive") {
    return { cls: "running", text: "owner alive", title: "The owner is working" };
  }
  if (node.owner_state === "unknown" || node.owner_state === undefined || node.owner_state === null) {
    return { cls: "waiting", text: "owner unknown", title: "The owner could not be checked" };
  }
  return null;
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
