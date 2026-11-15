import { queryClient } from "../api/queries";
import { dropEtag } from "../api/queries";
import { runKeys } from "./queries";

/** After a stop or retry: drop the cached "unchanged" tag and refetch now instead of waiting for the next tick. */
export async function refetchRun(runId: string): Promise<void> {
  dropEtag(runKeys.run(runId));
  dropEtag(runKeys.runs);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [runKeys.run(runId)] }),
    queryClient.invalidateQueries({ queryKey: [runKeys.runs] }),
  ]);
}
