import { storage } from "uxp";
import { EncoderManager, TickTime } from "premierepro";
import type { LoadedAudioSource } from "../input/audioPicker";

// Video containers we extract audio from locally before separation. Premiere/AME decode the
// container, so the exact video codec inside (H.264, ProRes, …) doesn't matter — we only pull
// the audio track. Keep this disjoint from audioPicker's SUPPORTED_EXTS (those upload as-is).
export const VIDEO_EXTS = new Set([
  "mov",
  "mp4",
  "m4v",
  "avi",
  "mkv",
  "mxf",
  "mts",
  "m2ts",
  "mpg",
  "mpeg",
  "wmv",
  "webm",
]);

export function isVideoExt(ext: string): boolean {
  return VIDEO_EXTS.has(ext.toLowerCase());
}

export function isVideoPath(path: string): boolean {
  return isVideoExt(path.toLowerCase().split(".").pop() ?? "");
}

// Bundled audio-only export preset (Adobe "MP3 192 kbps High Quality", DoVideo=false). MP3 keeps
// the upload small (~1.4 MB/min vs ~10 MB/min for WAV) and is unambiguously a .mp3 the separation
// server already accepts. Lives at the plugin root (copied from public/ at build time).
const PRESET_ASSET = "vibi-extract-mp3.epr";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// The bundled .epr can't be handed to AME by its in-plugin path (the plugin folder isn't a
// plain OS path AME can read), so copy it into the temp folder once and reuse that nativePath.
let presetPathPromise: Promise<string> | null = null;
async function resolvePresetPath(): Promise<string> {
  if (!presetPathPromise) {
    presetPathPromise = (async () => {
      const pluginFolder = await storage.localFileSystem.getPluginFolder();
      const asset = await pluginFolder.getEntry(PRESET_ASSET);
      const bytes = await asset.read({ format: storage.formats.binary });
      const temp = await storage.localFileSystem.getTemporaryFolder();
      const file = await temp.createFile(PRESET_ASSET, { overwrite: true });
      await file.write(bytes, { format: storage.formats.binary });
      return file.nativePath;
    })().catch((e) => {
      presetPathPromise = null; // let a later call retry
      throw e;
    });
  }
  return presetPathPromise;
}

async function fileSize(nativePath: string): Promise<number> {
  try {
    const entry = await storage.localFileSystem.getEntryWithUrl(`file:${nativePath}`);
    const meta = await entry.getMetadata();
    return meta?.size ?? 0;
  } catch {
    // Output not created yet (AME still spinning up / encoding) — treat as 0 bytes.
    return 0;
  }
}

export interface ConvertOptions {
  onStatus?: (message: string) => void;
}

// Extract the audio track of a video file into a small MP3 using Premiere's own encoder (Adobe
// Media Encoder). Fully local — no upload of the (often huge) video. `mediaPath` is the OS path
// of the source clip; returns a LoadedAudioSource ready to feed the normal separation flow.
export async function convertVideoToAudio(
  mediaPath: string,
  opts: ConvertOptions = {},
): Promise<LoadedAudioSource> {
  const onStatus = opts.onStatus ?? (() => {});
  const sourceName = mediaPath.split(/[\\/]/).pop() ?? "clip";
  const base = sourceName.replace(/\.[^.]+$/, "") || "audio";

  if (!EncoderManager || !TickTime) {
    throw new Error("Audio extraction from video isn't available in this environment.");
  }
  const manager = EncoderManager.getManager();
  if (!manager?.isAMEInstalled) {
    throw new Error(
      `"${sourceName}" is a video. Extracting its audio needs Adobe Media Encoder, which ` +
        `isn't installed (or its version is incompatible). Install AME, or add an audio file instead.`,
    );
  }

  // Unique output so concurrent/repeat conversions never collide.
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const temp = await storage.localFileSystem.getTemporaryFolder();
  const outFile = await temp.createFile(`vibi-${base}-${token}.mp3`, { overwrite: true });
  const outPath = outFile.nativePath;
  const presetPath = await resolvePresetPath();

  onStatus(`Extracting audio from "${sourceName}"… (starting Adobe Media Encoder)`);
  // startQueueImmediately=true so AME renders on its own — the user never has to click "Start
  // Queue" in the AME window. workArea=0 (entire file), removeUponCompletion=false. Extra args are
  // ignored on host versions that don't support them, so this stays safe.
  const queued = await manager.encodeFile(
    mediaPath,
    outPath,
    presetPath,
    TickTime.TIME_ZERO,
    TickTime.TIME_INVALID,
    0,
    false,
    true,
  );
  if (queued === false || queued === 0) {
    throw new Error(`Adobe Media Encoder rejected "${sourceName}". Make sure the clip is online and readable.`);
  }
  // Belt-and-suspenders: on versions where encodeFile only queues, this starts the batch too
  // (harmless if it's already running).
  try {
    await manager.startBatchEncode();
  } catch {
    /* already encoding, or not needed on this version */
  }

  // No reliable cross-version completion event, so watch the output file grow and settle. AME's
  // first launch can take ~30 s before any bytes appear; once it does, audio-only MP3 finishes
  // quickly. We declare done when the size stays put for a few consecutive polls.
  const POLL_MS = 1500;
  const STABLE_TICKS = 3; // ~4.5 s unchanged after data exists
  const START_TIMEOUT_MS = 5 * 60_000; // bytes must appear within 5 min (covers cold AME start)
  const TOTAL_TIMEOUT_MS = 30 * 60_000; // overall cap

  const startedAt = Date.now();
  let lastSize = 0;
  let stable = 0;
  let everGrew = false;

  for (;;) {
    await sleep(POLL_MS);
    const size = await fileSize(outPath);

    if (size > 0) {
      everGrew = true;
      onStatus(`Extracting audio from "${sourceName}"… (${(size / 1_048_576).toFixed(1)} MB)`);
      stable = size === lastSize ? stable + 1 : 0;
      lastSize = size;
      if (stable >= STABLE_TICKS) break;
    }

    const elapsed = Date.now() - startedAt;
    if (!everGrew && elapsed > START_TIMEOUT_MS) {
      throw new Error(
        `Audio extraction didn't start. Check that Adobe Media Encoder opened and isn't blocked ` +
          `by a dialog, then try "${sourceName}" again.`,
      );
    }
    if (elapsed > TOTAL_TIMEOUT_MS) {
      throw new Error(`Audio extraction from "${sourceName}" timed out.`);
    }
  }

  onStatus(`Audio extracted from "${sourceName}".`);
  const bytes = await outFile.read({ format: storage.formats.binary });
  if (bytes.byteLength === 0) {
    throw new Error(`Audio extraction from "${sourceName}" produced an empty file.`);
  }
  return { bytes, fileName: `${base}.mp3`, ext: "mp3", byteLength: bytes.byteLength };
}
