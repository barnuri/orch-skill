import { createContext, use } from "react";
import type { Tab } from "./automation-logic";

export interface AutomationApi {
  chatId: string;
  counts: { schedules: number; loops: number; monitors: number; total: number; live: boolean };
  /** Opens the list sheet on a tab. */
  openList: (tab?: Tab) => void;
  /** Opens the creation sheet for a kind, with the text of the composer or a message as the prompt. */
  openCreate: (kind: Tab, prefill?: string) => void;
  /** Runs a composer line that is an automation command. Resolves undefined for ordinary text, null on success, else the problem. */
  slash: (text: string) => Promise<string | null | undefined>;
}

export const AutomationContext = createContext<AutomationApi | null>(null);

/** The chat's automation controls, or null where no host is mounted (a page without a chat). */
export function useAutomation(): AutomationApi | null {
  return use(AutomationContext);
}
