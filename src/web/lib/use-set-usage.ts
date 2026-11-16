import { useState } from "react";
import type { Use } from "../../shared/profile-usage";
import { choiceFromUsage } from "../../shared/profile-usage";
import { api } from "../api/client";
import { invalidateDocument, keys, queryClient } from "../api/queries";
import { describeFailure } from "../api/result";
import { useToast } from "../components/Toast";
import { USE_LABEL, nextChoice } from "./usage-ui";

/** Saves a profile's or harness's usage at once (PATCH), toasts the outcome and refreshes what shows it. */
export function useSetUsage(kind: "profile" | "harness") {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const change = async (id: string, current: readonly Use[], use: Use, on: boolean): Promise<void> => {
    const choice = nextChoice(current, use, on);
    if (choice === null) {
      toast("error", `${id} must stay on for at least one use`);
      return;
    }
    setBusy(id);
    const result = await api.setUsage(kind, id, choice);
    if (result.kind === "ok") {
      toast("ok", `${id}: ${on ? "" : "no longer "}${USE_LABEL[use]} (${choiceFromUsage(result.body.usage)})`);
      await invalidateDocument("profiles");
      await queryClient.invalidateQueries({ queryKey: [keys.harnesses] });
    } else {
      toast("error", result.kind === "network" ? `Could not save ${id}` : describeFailure(result as never, `Could not save ${id}`));
    }
    setBusy(null);
  };
  return { busy, change };
}
