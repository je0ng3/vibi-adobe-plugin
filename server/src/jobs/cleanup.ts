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
// Idle safety-net interval. The sweep issues real DELETE queries, so every fire WAKES Neon —
// and a woken Neon compute stays billed for its autosuspend window (~5 min) afterward. At the
// old 10-min cadence that pinned the DB awake ~24/7 and burned the free compute allowance even
// with zero traffic. Cleanup is pure GC (nothing here is time-critical), so the idle cadence
// can be long; 6h fires ~4x/day. Timely GC during active periods comes from requestSweep()
// below instead, which piggybacks on a DB that the job itself already woke.
const SWEEP_INTERVAL_MS = Number(process.env.JOB_SWEEP_INTERVAL_MS ?? 6 * 60 * 60 * 1000); // 6h
// During active use we still want GC to run roughly this often — but only triggered by real
// activity (requestSweep), never as a standalone idle wake. Throttle so a burst of job
// completions coalesces into one sweep.
const ACTIVE_SWEEP_MIN_GAP_MS = Number(process.env.JOB_SWEEP_ACTIVE_GAP_MS ?? 10 * 60 * 1000); // 10 min

let lastSweepAt = 0;
let sweepInFlight = false;

async function sweep(): Promise<void> {
  // Guard against the idle interval and a requestSweep() firing concurrently.
  if (sweepInFlight) return;
  sweepInFlight = true;
  lastSweepAt = Date.now();
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
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Piggyback GC on job activity. Callers invoke this when the DB is already awake (e.g. a job
 * just finished writing its terminal status), so cleanup stays timely during active periods
 * WITHOUT the fixed interval having to wake Neon on its own. Throttled to one sweep per
 * ACTIVE_SWEEP_MIN_GAP_MS so a burst of completions coalesces into a single pass.
 */
export function requestSweep(): void {
  if (Date.now() - lastSweepAt < ACTIVE_SWEEP_MIN_GAP_MS) return;
  void sweep();
}

export function startCleanupSweep(): void {
  void sweep();
  const timer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  timer.unref?.();
}
