// Shared display formatters. Several panels previously hand-rolled these and drifted (minute
// zero-padding, and the `1024/1024` vs `1_048_576` byte literal); this is the single home.

// Seconds → "M:SS" (or "MM:SS" with padMinutes) elapsed/total readout. Non-finite/negative → 0.
export function formatClock(totalSec: number, opts: { padMinutes?: boolean } = {}): string {
  const t = Number.isFinite(totalSec) && totalSec > 0 ? totalSec : 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const mm = opts.padMinutes ? m.toString().padStart(2, "0") : String(m);
  return `${mm}:${s.toString().padStart(2, "0")}`;
}

// Bytes → "12.3" MB (one decimal). Caller appends the " MB" unit.
export function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
