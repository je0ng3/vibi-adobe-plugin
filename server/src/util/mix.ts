import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mix several audio inputs (any format ffmpeg can read — Perso speaker stems aren't always
// plain PCM WAV) with per-input volume, returning a 16-bit PCM WAV. The UXP panel can't
// decode/mix these itself (no Web Audio, and the stems aren't WAV the pure-JS path handles).

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export interface MixInput {
  bytes: ArrayBuffer;
  volume: number; // percent; 100 = unity
}

export async function mixAudio(inputs: MixInput[]): Promise<Buffer> {
  if (inputs.length === 0) throw new Error("no inputs");
  const dir = await mkdtemp(join(tmpdir(), "vibi-mix-"));
  try {
    const paths = await Promise.all(
      inputs.map(async (inp, i) => {
        const p = join(dir, `in${i}`);
        await writeFile(p, Buffer.from(inp.bytes));
        return p;
      }),
    );
    return await ffmpegMix(paths, inputs.map((i) => i.volume));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function ffmpegMix(paths: string[], volumes: number[]): Promise<Buffer> {
  const n = paths.length;
  const args: string[] = [];
  for (const p of paths) args.push("-i", p);

  // Per-input volume, then amix. normalize=0 keeps each input's level (default amix divides
  // by the input count, which would quietly attenuate the mix).
  let filter = "";
  for (let i = 0; i < n; i++) {
    const g = Math.min(1.5, Math.max(0, volumes[i] / 100)).toFixed(4);
    filter += `[${i}:a]volume=${g}[a${i}];`;
  }
  for (let i = 0; i < n; i++) filter += `[a${i}]`;
  filter += `amix=inputs=${n}:normalize=0[out]`;

  args.push("-filter_complex", filter, "-map", "[out]", "-ac", "2", "-f", "wav", "pipe:1");

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
        reject(new Error(`ffmpeg mix exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 500)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
