import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
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
    const outPath = join(dir, "out.wav");
    await ffmpegMix(paths, inputs.map((i) => i.volume), outPath);
    // Read the finished file back. ffmpeg wrote to a seekable path (not a pipe), so it patched
    // the RIFF/`data` chunk sizes correctly — a streamed `pipe:1` WAV leaves those as placeholders,
    // which makes Premiere flag "inconsistent file structure" and disable metadata/playback.
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function ffmpegMix(paths: string[], volumes: number[], outPath: string): Promise<void> {
  const n = paths.length;
  const args: string[] = [];
  for (const p of paths) args.push("-i", p);

  // amix assumes every input already shares one sample rate / sample format / channel layout —
  // it does NOT resample. Stems that each decode fine on their own but differ here (e.g. a mono
  // speaker stem + a stereo background, or 44.1k + 48k) otherwise mix at the wrong speed/length,
  // so a voice can "drop out" partway while another stem keeps playing. Normalize every input to
  // 48k / fltp / stereo BEFORE applying per-input volume and amixing. normalize=0 keeps each
  // input's level (default amix divides by the input count, quietly attenuating the mix);
  // duration=longest is the default but pinned here so the mix always spans the longest stem.
  const FMT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";
  let filter = "";
  for (let i = 0; i < n; i++) {
    const g = Math.min(1.5, Math.max(0, volumes[i] / 100)).toFixed(4);
    filter += `[${i}:a]${FMT},volume=${g}[a${i}];`;
  }
  for (let i = 0; i < n; i++) filter += `[a${i}]`;
  filter += `amix=inputs=${n}:normalize=0:duration=longest[out]`;

  // Output to a seekable file (-y to overwrite) rather than pipe:1 so ffmpeg backfills the WAV
  // header sizes; "-f wav" is implied by the .wav path but kept explicit.
  args.push("-filter_complex", filter, "-map", "[out]", "-ac", "2", "-ar", "48000", "-f", "wav", "-y", outPath);

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    const errChunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.on("error", (e) =>
      reject(new Error(`ffmpeg failed to start (is it installed? set FFMPEG_PATH): ${e.message}`)),
    );
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg mix exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 500)}`));
        return;
      }
      resolve();
    });
  });
}
