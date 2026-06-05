import { deleteJobsOlderThan } from "./jobStore.js";
import { deleteStemsForJob } from "./stemStore.js";
import { deleteExpiredDeviceCodes } from "../auth/deviceStore.js";

// Jobs (and their on-disk stems) are transient working data — drop them after this age.
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS ?? 60 * 60 * 1000); // 1 hour
const SWEEP_INTERVAL_MS = Number(process.env.JOB_SWEEP_INTERVAL_MS ?? 10 * 60 * 1000); // 10 min

async function sweep(): Promise<void> {
  try {
    const removed = await deleteJobsOlderThan(JOB_TTL_MS);
    // allSettled, not all: the job rows are already gone, so a single stem-delete failure
    // must not abort the batch and orphan the rest (they'd have no row to retry from).
    const results = await Promise.allSettled(removed.map((id) => deleteStemsForJob(id)));
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) console.error(`[cleanup] ${failed.length} stem deletion(s) failed:`, failed);
    if (removed.length > 0) console.log(`[cleanup] removed ${removed.length} expired job(s) and their stems`);
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
