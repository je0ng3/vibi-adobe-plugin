import { deleteStemsForJob } from "./stemStore.js";
import { objectStore } from "./objectStore.js";
import { ObjectKey } from "../routes/downloadResponder.js";

/**
 * Remove all of a separation job's stem bytes — both the local disk copy and the R2 objects.
 * Shared by the cleanup sweep (expired / pruned history) and the explicit DELETE route, so the
 * two never drift. Best-effort and idempotent: a missing file or absent R2 object is a no-op.
 */
export async function purgeSeparationArtifacts(jobId: string): Promise<void> {
  await deleteStemsForJob(jobId).catch((e) => console.error(`[artifacts] disk purge ${jobId} failed:`, e));
  if (objectStore) {
    await objectStore
      .deletePrefix(ObjectKey.separationPrefix(jobId))
      .catch((e) => console.error(`[artifacts] R2 purge ${jobId} failed:`, e));
  }
}
