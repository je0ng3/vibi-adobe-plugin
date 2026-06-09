// In-panel audio preview through a hidden <video> element.
//
// UXP exposes no audio *output* to the web layer — AudioContext is absent and <audio>.play() is
// inert (see player.ts / KNOWN_ISSUES). But a <video> element DOES emit audio for an audio-only
// source inside the Premiere panel, so we drive one offscreen <video> as the playback engine.
// Unlike the Source Monitor backend this stays entirely in-panel and gives us everything the
// Web Audio path had: real sound, video.currentTime for the playhead, currentTime= for seek, and
// — crucially — live per-stem gain via video.volume (the Source Monitor backend can't do gain).
//
// Source loading: UXP's createObjectURL yields a fake `blob:/blob-N` handle the <video> can't
// fetch (MediaError code 4 "unsupported URL"), so we never feed it the blob handle. Instead we
// write the bytes to a temp file and try real schemes the element can actually load — a `file://`
// path first, a `data:` URL as fallback — keeping whichever one fires a load event.
//
// This module mirrors the player.ts interface so it can be a drop-in backend.

import { storage } from "uxp";
import { audioUrlToBytes } from "./audioUrl";
import { parseWav } from "./wav";
import { probeDurationSec } from "./duration";

let el: HTMLVideoElement | null = null;

function hasDom(): boolean {
  return typeof document !== "undefined" && typeof document.createElement === "function";
}

// True if we can construct a <video> element at all. Whether it actually emits audio is a
// runtime property of the host we can't probe synchronously; playback failures degrade to the
// next backend (Source Monitor) via player.ts since play() returns 0 on error.
export function supported(): boolean {
  if (!hasDom()) return false;
  try {
    const v = document.createElement("video");
    return typeof v.play === "function";
  } catch {
    return false;
  }
}

function getEl(): HTMLVideoElement {
  if (el) return el;
  const v = document.createElement("video");
  // Present in the DOM (some engines won't decode/emit audio for a detached or display:none
  // element) but visually out of the way and non-interactive.
  v.setAttribute("playsinline", "");
  v.style.position = "absolute";
  v.style.width = "1px";
  v.style.height = "1px";
  v.style.opacity = "0";
  v.style.pointerEvents = "none";
  v.style.left = "-9999px";
  document.body.appendChild(v);
  el = v;
  return v;
}

// --- playback state ---
let currentId: string | null = null;
let currentDuration = 0;
let endedCb: (() => void) | null = null;
let currentVolume = 100;

// Temp file per clip id, written once and reused so re-play just re-points the element.
const tempPaths = new Map<string, string>();

export function playingId(): string | null {
  return currentId;
}

export function getCurrentTime(): number {
  return el ? el.currentTime || 0 : 0;
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
  const safe = `vibi-vplay-${id.replace(/[^\w.-]+/g, "_")}.wav`;
  const file = await folder.createFile(safe, { overwrite: true });
  await file.write(bytes, { format: storage.formats.binary });
  const path = (file as unknown as { nativePath: string }).nativePath;
  tempPaths.set(id, path);
  return path;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// Self-contained base64 (btoa isn't guaranteed in UXP). Used to build a data: URL fallback.
function toBase64(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let out = "";
  let i = 0;
  for (; i + 2 < u8.length; i += 3) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = u8.length - i;
  if (rem === 1) {
    const n = u8[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rem === 2) {
    const n = (u8[i] << 16) | (u8[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return out;
}

// Point the element at `src` and wait for it to either become playable or error out (with a
// timeout so a stub that fires neither doesn't hang us). Returns true if the source loaded.
function tryLoad(v: HTMLVideoElement, src: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeEventListener("loadeddata", onOk);
      v.removeEventListener("canplay", onOk);
      v.removeEventListener("error", onErr);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const timer = setTimeout(() => finish(false), 4000);
    v.addEventListener("loadeddata", onOk);
    v.addEventListener("canplay", onOk);
    v.addEventListener("error", onErr);
    try {
      v.src = src;
      v.load?.();
    } catch {
      finish(false);
    }
  });
}

export async function play(
  id: string,
  url: string,
  opts?: { volume?: number; onEnded?: () => void; durationSec?: number },
): Promise<number> {
  if (!supported()) return 0;
  const v = getEl();
  detach();

  let bytes: ArrayBuffer;
  try {
    bytes = await audioUrlToBytes(url);
  } catch (e) {
    console.warn("[videoPlayer] read failed:", e);
    return 0;
  }

  currentVolume = opts?.volume ?? 100;
  currentId = id;
  endedCb = opts?.onEnded ?? null;
  currentDuration =
    opts?.durationSec && opts.durationSec > 0 ? opts.durationSec : durationOf(bytes);
  v.volume = Math.max(0, Math.min(1, currentVolume / 100));
  v.onended = () => {
    if (currentId === id) {
      const cb = endedCb;
      stop();
      cb?.();
    }
  };

  let tempPath: string;
  try {
    tempPath = await ensureTemp(id, bytes);
  } catch (e) {
    console.warn("[videoPlayer] temp write failed:", e);
    resetState();
    return 0;
  }

  // Load a source the element can actually fetch. UXP's createObjectURL yields a fake blob: handle
  // the <video> rejects (MediaError 4), so we use the temp file's `file://` path, falling back to
  // an inline data: URL. Keep the first scheme that loads.
  const candidates = [`file://${tempPath}`, () => `data:audio/wav;base64,${toBase64(bytes)}`];
  let loaded = false;
  for (const c of candidates) {
    if (await tryLoad(v, typeof c === "function" ? c() : c)) {
      loaded = true;
      break;
    }
  }
  if (!loaded) {
    console.warn("[videoPlayer] no source scheme loaded");
    resetState();
    return 0;
  }

  try {
    v.currentTime = 0;
    await v.play();
  } catch (e) {
    console.warn("[videoPlayer] play failed:", e);
    resetState();
    return 0;
  }
  if (Number.isFinite(v.duration) && v.duration > 0) currentDuration = v.duration;
  return currentDuration;
}

function detach() {
  if (!el) return;
  el.onended = null;
  try {
    el.pause();
  } catch {
    /* ignore */
  }
}

function resetState() {
  currentId = null;
  endedCb = null;
  currentDuration = 0;
}

export function stop(): void {
  detach();
  resetState();
}

export function setVolume(volume: number): void {
  currentVolume = volume;
  if (el) el.volume = Math.max(0, Math.min(1, volume / 100));
}

export function seek(ratio: number): void {
  if (!el || currentDuration <= 0) return;
  el.currentTime = Math.max(0, Math.min(1, ratio)) * currentDuration;
}
