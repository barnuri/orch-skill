import type { ProfileSanityEnvelope } from "../../shared/types/profile-sanity";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { mergeResults, sanityToast } from "./sanity-logic";

export interface SanityState {
  running: boolean;
  data: ProfileSanityEnvelope | null;
  error: string | null;
  /** Which profiles the in-flight probe covers; null means all of them. */
  pending: readonly string[] | null;
}

type Notify = (kind: "ok" | "error", text: string) => void;

/**
 * The sanity probe, kept outside the page so results survive navigating away and back. One probe
 * runs at a time. A single-profile probe merges into the table instead of blanking the other rows.
 */
class SanityStore {
  private state: SanityState = { running: false, data: null, error: null, pending: null };
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly get = (): SanityState => this.state;

  /** Whether the current probe covers `profile`: one row, not the whole table. */
  pendingFor(profile: string): boolean {
    return this.state.running && (this.state.pending === null || this.state.pending.includes(profile));
  }

  async run(profiles: readonly string[] | undefined, notify: Notify): Promise<void> {
    if (this.state.running) {
      return;
    }
    this.set({
      ...this.state,
      running: true,
      error: null,
      pending: profiles === undefined || profiles.length === 0 ? null : [...profiles],
    });
    const result = await api.profileSanity(profiles);
    if (result.kind === "ok") {
      const toast = sanityToast(result.body);
      this.set({ running: false, pending: null, error: null, data: mergeResults(this.state.data, result.body) });
      notify(toast.kind, toast.text);
      return;
    }
    const message = result.kind === "error" ? (result.body?.error ?? "Sanity test failed") : "Sanity test failed";
    this.set({ ...this.state, running: false, pending: null, error: result.kind === "invalid" ? describeFailure(result, message) : message });
  }

  reset(): void {
    this.set({ running: false, data: null, error: null, pending: null });
  }

  private set(next: SanityState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const sanity = new SanityStore();
