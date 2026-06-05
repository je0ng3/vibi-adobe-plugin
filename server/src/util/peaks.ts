import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Decode any supported audio (mp3/m4a/wav) to mono PCM via ffmpeg and reduce it to a small
// set of normalized peak heights. The UXP panel can't decode mp3/AAC itself, so it asks the
// server for the input preview waveform. ffmpeg comes from PATH (override with FFMPEG_PATH).

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const SR = 8000; // plenty for a waveform overview; keeps the PCM buffer tiny

export interface PeaksResult {
  peaks: number[];
  durationSec: number;
}

export async function computePeaks(bytes: ArrayBuffer, ext: string, barCount = 200): Promise<PeaksResult> {
  const dir = await mkdtemp(join(tmpdir(), "vibi-peaks-"));
  const input = join(dir, `in.${ext || "bin"}`);
  try {
    await writeFile(input, Buffer.from(bytes));
    const pcm = await ffmpegDecode(input);
    return reducePeaks(pcm, barCount);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Decode to 32-bit float mono raw PCM on stdout.
function ffmpegDecode(inputPath: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ["-v", "error", "-i", inputPath, "-ac", "1", "-ar", String(SR), "-f", "f32le", "pipe:1"];
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
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 500)}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      // Align to 4-byte float boundary defensively.
      const usable = buf.byteLength - (buf.byteLength % 4);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, usable / 4));
    });
  });
}

function reducePeaks(data: Float32Array, barCount: number): PeaksResult {
  const durationSec = data.length / SR;
  const bucket = Math.max(1, Math.floor(data.length / barCount));
  const peaks = new Array<number>(barCount).fill(0);
  let maxOverall = 0;
  for (let i = 0; i < barCount; i++) {
    let max = 0;
    const start = i * bucket;
    const end = Math.min(start + bucket, data.length);
    for (let j = start; j < end; j++) {
      const a = Math.abs(data[j]);
      if (a > max) max = a;
    }
    peaks[i] = max;
    if (max > maxOverall) maxOverall = max;
  }
  if (maxOverall > 0) for (let i = 0; i < barCount; i++) peaks[i] /= maxOverall;
  return { peaks, durationSec };
}
