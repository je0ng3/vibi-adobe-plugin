import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate one speaker from the original audio by time: keep the audio only during that speaker's
// segments and mute everything else, preserving the original length/timing (so the result lines
// up on a Premiere track). Input may be any format ffmpeg reads; output is 16-bit PCM WAV.
// Used by the script-based "editable separation" flow — the UXP panel can't cut audio itself.

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export async function segmentSpeaker(bytes: ArrayBuffer, ranges: TimeRange[]): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vibi-seg-"));
  try {
    const input = join(dir, "in");
    await writeFile(input, Buffer.from(bytes));
    return await ffmpegSegment(input, ranges);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function ffmpegSegment(inputPath: string, ranges: TimeRange[]): Promise<Buffer> {
  // Build a mute-outside-ranges filter. `volume=0` is applied only when enabled; we enable it
  // whenever the playhead is NOT inside any speaker range → silence between segments, original
  // audio (unchanged gain) inside them. With no ranges, mute everything (full-length silence).
  const clauses = ranges
    .filter((r) => r.endMs > r.startMs)
    .map((r) => `between(t,${(r.startMs / 1000).toFixed(3)},${(r.endMs / 1000).toFixed(3)})`);
  const enable = clauses.length === 0 ? "1" : `not(${clauses.join("+")})`;
  const filter = `volume=enable='${enable}':volume=0`;

  const args = ["-v", "error", "-i", inputPath, "-af", filter, "-ac", "2", "-f", "wav", "pipe:1"];

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.on("error", (e) =>
      reject(new Error(`ffmpeg failed to start (is it installed? set FFMPEG_PATH): ${e.message}`)),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg segment exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 500)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
