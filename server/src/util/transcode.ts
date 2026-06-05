import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Normalize a stem to standard 16-bit PCM WAV. Perso speaker stems (extracted from the
// originalVoiceSpeakers tar) aren't always plain PCM WAV, which breaks the panel's pure-JS
// WAV parsing (waveforms, playback). Transcoding at store time means the client always gets
// a WAV it can decode itself. Falls back to the original bytes if ffmpeg is unavailable.

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export async function transcodeToWav(bytes: ArrayBuffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vibi-xcode-"));
  const input = join(dir, "in");
  try {
    await writeFile(input, Buffer.from(bytes));
    return await run(input);
  } catch (e) {
    console.warn("[transcode] failed, keeping original stem bytes:", e);
    return Buffer.from(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(inputPath: string): Promise<Buffer> {
  // 44.1kHz stereo 16-bit PCM — a format every consumer (incl. the panel's parseWav) reads.
  const args = ["-v", "error", "-i", inputPath, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"];
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));
    proc.on("error", (e) => reject(new Error(`ffmpeg start failed: ${e.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 300)}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}
