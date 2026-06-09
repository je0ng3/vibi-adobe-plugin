// In-panel audio preview through Premiere's own playback engine.
//
// UXP exposes no audio *output* API to the web layer — Web Audio (AudioContext) is absent in
// Premiere and the <audio> element's play() is inert (see player.ts / KNOWN_ISSUES). The one
// remaining way to make sound that the panel itself drives is the host's Source Monitor:
// `SourceMonitor.openFilePath()` + `play()` emit real audio, and `getPosition()` lets us read
// the playhead back so the panel's own waveform progress bar tracks it. This module mirrors the
// player.ts interface so it can be a drop-in backend when Web Audio is unavailable.
//
// Trade-offs vs. the Web Audio backend: playback happens in Premiere's Source Monitor (the host
// UI), not a custom in-panel graph, so there's no live per-stem gain — setVolume is a no-op here
// (the fader still shapes the eventual server-side mix). Position is polled (~60ms), so the bar
// is host-accurate rather than sample-accurate.

import { SourceMonitor, TickTime } from "premierepro";
import { storage } from "uxp";
import { audioUrlToBytes } from "./audioUrl";
import { parseWav } from "./wav";
import { probeDurationSec } from "./duration";

interface TickTimeValue {
  seconds: number;
}
interface SourceMonitorApi {
  openFilePath: (nativePath: string) => Promise<unknown>;
  play: (speed: number) => Promise<unknown>;
  getPosition: () => Promise<TickTimeValue>;
  setPosition: (position: unknown) => Promise<boolean>;
  closeClip?: () => Promise<unknown>;
  closeAllClips?: () => Promise<unknown>;
}
interface TickTimeApi {
  createWithSeconds: (seconds: number) => unknown;
  TIME_ZERO: unknown;
}

const sm = SourceMonitor as unknown as SourceMonitorApi | null;
const tt = TickTime as unknown as TickTimeApi | null;

export function supported(): boolean {
  return (
    !!sm &&
    typeof sm.openFilePath === "function" &&
    typeof sm.play === "function" &&
    typeof sm.getPosition === "function" &&
    !!tt &&
    typeof tt.createWithSeconds === "function"
  );
}

// Stop within this many seconds of the end → treat the clip as finished (the Source Monitor
// holds the playhead at the out point rather than firing an "ended" event we can subscribe to).
const END_EPSILON = 0.12;
const POLL_MS = 60;

// Temp WAV per clip id, written once and reused so re-play is a bare openFilePath().
const tempPaths = new Map<string, string>();

let currentId: string | null = null;
let currentDuration = 0;
let currentSec = 0;
let endedCb: (() => void) | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function playingId(): string | null {
  return currentId;
}

export function getCurrentTime(): number {
  return currentSec;
}

function durationOf(bytes: ArrayBuffer): number {
  const pcm = parseWav(bytes);
  if (pcm && pcm.length > 0) return pcm.length / pcm.sampleRate;
  return probeDurationSec(bytes) ?? 0;
}

async function ensureTemp(id: string, bytes: ArrayBuffer): Promise<string> {
  const existing = tempPaths.get(id);
  if (existing) return existing;
  const folder = await storage.localFileSystem.getTemporaryFolder();
  const safe = `vibi-preview-${id.replace(/[^\w.-]+/g, "_")}.wav`;
  const file = await folder.createFile(safe, { overwrite: true });
  await file.write(bytes, { format: storage.formats.binary });
  const path = (file as unknown as { nativePath: string }).nativePath;
  tempPaths.set(id, path);
  return path;
}

function stopPoll() {
  if (pollTimer != null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll() {
  stopPoll();
  pollTimer = setTimeout(pollOnce, POLL_MS);
}

async function pollOnce() {
  if (!sm || currentId == null) return;
  try {
    const pos = await sm.getPosition();
    const s = typeof pos?.seconds === "number" ? pos.seconds : currentSec;
    currentSec = s;
    if (currentDuration > 0 && s >= currentDuration - END_EPSILON) {
      const cb = endedCb;
      resetState();
      void halt();
      cb?.();
      return;
    }
  } catch {
    /* transient host error — keep polling */
  }
  if (currentId != null) schedulePoll();
}

function resetState() {
  stopPoll();
  currentId = null;
  endedCb = null;
  currentSec = 0;
  currentDuration = 0;
}

async function halt() {
  try {
    await sm?.play?.(0.0); // speed 0 = pause the transport
  } catch {
    /* ignore */
  }
  try {
    await sm?.closeClip?.(); // guarantee silence even if pause is a no-op in this build
  } catch {
    /* ignore */
  }
}

// Start playing `url` (identified by `id`). Stops whatever was playing. Returns the clip
// duration in seconds (0 if playback couldn't start).
export async function play(
  id: string,
  url: string,
  opts?: { volume?: number; onEnded?: () => void; durationSec?: number },
): Promise<number> {
  if (!sm || !tt) return 0;
  resetState();
  let bytes: ArrayBuffer;
  try {
    bytes = await audioUrlToBytes(url);
  } catch (e) {
    console.warn("[sourceMonitor] read failed:", e);
    return 0;
  }
  currentDuration = opts?.durationSec && opts.durationSec > 0 ? opts.durationSec : durationOf(bytes);
  try {
    const path = await ensureTemp(id, bytes);
    await sm.openFilePath(path);
    try {
      await sm.setPosition(tt.TIME_ZERO);
    } catch {
      /* some builds reject setPosition right after open — playback still starts at 0 */
    }
    currentId = id;
    currentSec = 0;
    endedCb = opts?.onEnded ?? null;
    await sm.play(1.0);
    schedulePoll();
  } catch (e) {
    console.warn("[sourceMonitor] play failed:", e);
    resetState();
    return 0;
  }
  return currentDuration;
}

export function stop(): void {
  resetState();
  void halt();
}

// Source Monitor plays the file as-is; per-stem gain isn't available on this path.
export function setVolume(_volume: number): void {
  /* no-op — see module header */
}

export function seek(ratio: number): void {
  if (!sm || !tt || currentId == null || currentDuration <= 0) return;
  const target = Math.max(0, Math.min(1, ratio)) * currentDuration;
  currentSec = target;
  void sm.setPosition(tt.createWithSeconds(target)).catch(() => {});
}
