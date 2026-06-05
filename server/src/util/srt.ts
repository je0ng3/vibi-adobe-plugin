import type { TranscriptSegment } from "../types/script.js";

export function buildSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${timecode(seg.startMs)} --> ${timecode(seg.endMs)}\n${seg.text}\n`)
    .join("\n");
}

function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return (
    `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(millis, 3)}`
  );
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}
