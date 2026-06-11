import {
  deleteStaleNonReadyJobs,
  deleteExpiredHistory,
  pruneHistoryOverLimit,
} from "./jobStore.js";
import { purgeSeparationArtifacts } from "./artifacts.js";
import { deleteExpiredDeviceCodes } from "../auth/deviceStore.js";

// Non-ready jobs (failed / interrupted / never-finished) are transient — drop them quickly.
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS ?? 60 * 60 * 1000); // 1 hour
// Ready separations are durable history. Keep them this long (and at most N per project) so a
// user's saved results survive sign-out/restart, while R2/disk growth stays bounded.
const HISTORY_TTL_MS = Number(process.env.HISTORY_TTL_MS ?? 90 * 24 * 60 * 60 * 1000); // 90 days
const HISTORY_MAX_PER_PROJECT = Number(process.env.HISTORY_MAX_PER_PROJECT ?? 50);
const SWEEP_INTERVAL_MS = Number(process.env.JOB_SWEEP_INTERVAL_MS ?? 10 * 60 * 1000); // 10 min

async function sweep(): Promise<void> {
  try {
    // Gather everything to remove this pass, then purge each one's stems (disk + R2).
    const removed = [
      ...(await deleteStaleNonReadyJobs(JOB_TTL_MS)),
      ...(await deleteExpiredHistory(HISTORY_TTL_MS)),
      ...(await pruneHistoryOverLimit(HISTORY_MAX_PER_PROJECT)),
    ];
    // allSettled, not all: the job rows are already gone, so a single purge failure must not
    // abort the batch and orphan the rest (they'd have no row to retry from).
    const results = await Promise.allSettled(removed.map((id) => purgeSeparationArtifacts(id)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) console.error(`[cleanup] ${failed.length} stem purge(s) failed:`, failed);
    if (removed.length > 0) console.log(`[cleanup] removed ${removed.length} job(s) and purged their stems`);
    const devicesRemoved = await deleteExpiredDeviceCodes();
    if (devicesRemoved > 0) console.log(`[cleanup] removed ${devicesRemoved} expired device code(s)`);
  } catch (e) {
    console.error("[cleanup] sweep failed:", e);
  }
}

export function startCleanupSweep(): void {
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}
