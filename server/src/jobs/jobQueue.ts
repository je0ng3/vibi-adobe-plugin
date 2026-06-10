// In-memory concurrency gate for separation jobs.
//
// The heavy separation itself runs on Perso, but THIS process still (a) holds the full uploaded
// audio buffer — up to 200MB — in memory for the job's lifetime and (b) spawns an ffmpeg
// transcode per extracted stem. On the 1GB / 0.25-vCPU e2-micro a burst of concurrent
// separations would OOM or peg the CPU. So cap how many run at once; excess submissions wait
// here while their job row stays "queued", and the client's existing poll loop surfaces the
// wait transparently (queued → processing once a slot frees).
//
// Single-instance only — fine for the current one e2-micro deployment. If this ever scales to
// multiple instances, replace this with a shared queue (DB row-lock / Redis).

const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_SEPARATIONS) || 2);
// Cap how many jobs may wait in line. Past this, new submissions are rejected (503) instead of
// piling up forever — a last-resort guard against unbounded backlog under a request flood.
const MAX_QUEUE_DEPTH = Math.max(1, Number(process.env.MAX_SEPARATION_QUEUE) || 8);

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
  // Hand the freed slot directly to the next waiter so `active` never dips below the work in
  // flight; only decrement when nobody is waiting.
  const next = waiters.shift();
  if (next) next();
  else active--;
}

/** Run `task` once a concurrency slot is free, releasing the slot when it settles. */
export async function runQueued<T>(task: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

/** True when the wait line is already at its cap, so callers should reject rather than enqueue. */
export function isQueueFull(): boolean {
  return waiters.length >= MAX_QUEUE_DEPTH;
}

export function queueDepth(): { active: number; waiting: number; max: number; maxQueue: number } {
  return { active, waiting: waiters.length, max: MAX_CONCURRENT, maxQueue: MAX_QUEUE_DEPTH };
}
