import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Extract the audio track of an UPLOADED media file (video or audio) to mp3 via ffmpeg. Used
// when the user pulls a Premiere timeline/Project selection whose source is a video (e.g. a .mov
// screen recording) — the panel can't decode it, and the separation backend only accepts
// mp3/m4a/wav. The client uploads the file BYTES (not a path): a path-based variant let an
// authed caller make the server ffmpeg-open any local path/URL (SSRF/LFI) and only worked when
// the server shared a filesystem with Premiere. We write the bytes to a server-controlled temp
// file, so ffmpeg's input is never attacker-influenced.

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

export async function extractAudioFromBytes(bytes: ArrayBuffer): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "vibi-extract-"));
  const input = join(dir, "in");
  try {
    await writeFile(input, Buffer.from(bytes));
    return await runFfmpeg(input);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(path: string): Promise<Buffer> {
  const args = ["-v", "error", "-i", path, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1"];
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
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString().slice(0, 400)}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      if (buf.byteLength === 0) {
        reject(new Error("no audio track in the selected media"));
        return;
      }
      resolve(buf);
    });
  });
}
