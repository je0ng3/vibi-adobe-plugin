// Playback facade. UXP's <audio> element has no working play()/pause() (KNOWN_ISSUES).
// Two backends, chosen at runtime and kept behind one interface so the panels don't care:
//   1. Web Audio (this file) — preferred when the runtime provides AudioContext (browser/dev):
//      sample-accurate position, live per-stem gain.
//   2. Source Monitor (sourceMonitorPlayer.ts) — used in Premiere UXP, where AudioContext is
//      absent: drives the host's own Source Monitor for real sound and polls its playhead so
//      the panel's progress bar still tracks. playbackSupported() is true if EITHER exists; only
//      when both are absent do we hide the play buttons and fall back to the OS-default preview.
//
// A single shared context plays one clip at a time (preview semantics). A GainNode lets the
// volume fader affect playback live. Buffers are cached per URL so re-play is instant.

import { parseWav } from "./wav";
import { audioUrlToBytes } from "./audioUrl";
import * as videoBackend from "./videoPlayer";
import * as sourceMonitor from "./sourceMonitorPlayer";

// Backend selection. Web Audio is the preferred in-panel engine (sample-accurate, live gain).
// When the runtime has no AudioContext (Premiere UXP), play through a hidden <video> element —
// it emits real sound in-panel and, unlike the Source Monitor, supports live per-stem gain
// (video.volume). The Source Monitor remains a fallback if <video> is somehow unavailable.
// All three share the same method signatures, so we dispatch through a single backend handle.
interface HostBackend {
  play: (
    id: string,
    url: string,
    opts?: { volume?: number; onEnded?: () => void; durationSec?: number },
  ) => Promise<number>;
  stop: () => void;
  pause: () => void;
  resume: () => void;
  setVolume: (volume: number) => void;
  getCurrentTime: () => number;
  seek: (ratio: number) => void;
  playingId: () => string | null;
}

function hostBackend(): HostBackend | null {
  if (audioContextCtor() != null) return null; // Web Audio path handles playback in-process
  if (videoBackend.supported()) return videoBackend;
  if (sourceMonitor.supported()) return sourceMonitor;
  return null;
}

let ctx: AudioContext | null = null;
let ctxResolved = false;

function audioContextCtor(): typeof AudioContext | null {
  const w = globalThis as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

// Construct lazily — on first play(), inside the click handler. Some runtimes only allow an
// AudioContext to start from a user gesture, so probing by constructing at load time can
// wrongly fail. Show the play buttons whenever the API *exists* (playbackSupported), and
// defer the actual construction to the click.
function getCtx(): AudioContext | null {
  if (ctxResolved) return ctx;
  ctxResolved = true;
  const Ctor = audioContextCtor();
  if (Ctor) {
    try {
      ctx = new Ctor();
    } catch {
      ctx = null;
    }
  }
  return ctx;
}

export function playbackSupported(): boolean {
  return audioContextCtor() != null || videoBackend.supported() || sourceMonitor.supported();
}

const bufferCache = new Map<string, AudioBuffer>();

async function getBuffer(url: string): Promise<AudioBuffer> {
  const c = getCtx()!;
  const cached = bufferCache.get(url);
  if (cached) return cached;
  const bytes = await audioUrlToBytes(url);
  let buffer: AudioBuffer;
  // Build the AudioBuffer from parsed PCM for WAV (stems/mix) so playback doesn't depend on
  // UXP's flaky decodeAudioData — only on AudioContext existing. Fall back for mp3/m4a.
  const pcm = parseWav(bytes);
  if (pcm && pcm.length > 0) {
    buffer = c.createBuffer(pcm.channels.length, pcm.length, pcm.sampleRate);
    for (let ch = 0; ch < pcm.channels.length; ch++) {
      buffer.getChannelData(ch).set(pcm.channels[ch]);
    }
  } else {
    buffer = await c.decodeAudioData(bytes.slice(0));
  }
  bufferCache.set(url, buffer);
  return buffer;
}

// --- current playback state ---
let source: AudioBufferSourceNode | null = null;
let gain: GainNode | null = null;
let currentId: string | null = null;
let currentUrl: string | null = null;
let currentVolume = 100;
let startedAtCtxTime = 0; // ctx.currentTime when the current source started
let startedAtOffset = 0; // seconds into the buffer where it started
let currentDuration = 0;
let endedCb: (() => void) | null = null;
let pausedOffset: number | null = null; // web 경로: pause 시 보존한 재생 위치(초). resume 의 시작점.

export function playingId(): string | null {
  const b = hostBackend();
  if (b) return b.playingId();
  return currentId;
}

function teardownSource() {
  if (source) {
    try {
      source.onended = null;
      source.stop();
    } catch {
      /* already stopped */
    }
  }
  source = null;
  gain = null;
}

export function stop(): void {
  const b = hostBackend();
  if (b) {
    b.stop();
    return;
  }
  teardownSource();
  currentId = null;
  currentUrl = null;
  endedCb = null;
  pausedOffset = null;
}

function startSource(c: AudioContext, buffer: AudioBuffer, offsetSec: number) {
  const src = c.createBufferSource();
  src.buffer = buffer;
  const g = c.createGain();
  g.gain.value = currentVolume / 100;
  src.connect(g).connect(c.destination);
  src.onended = () => {
    if (source === src) {
      const cb = endedCb;
      stop();
      cb?.();
    }
  };
  src.start(0, Math.max(0, Math.min(offsetSec, buffer.duration)));
  source = src;
  gain = g;
  startedAtCtxTime = c.currentTime;
  startedAtOffset = offsetSec;
  currentDuration = buffer.duration;
}

// Start playing `url` (identified by `id`). Stops whatever was playing. Returns the clip
// duration in seconds (0 if playback is unsupported / decode failed).
export async function play(
  id: string,
  url: string,
  opts?: { volume?: number; onEnded?: () => void; durationSec?: number },
): Promise<number> {
  const b = hostBackend();
  if (b) return b.play(id, url, opts);
  const c = getCtx();
  if (!c) return 0;
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      /* ignore */
    }
  }
  stop();
  let buffer: AudioBuffer;
  try {
    buffer = await getBuffer(url);
  } catch (e) {
    console.warn("[player] decode failed:", e);
    return 0;
  }
  currentVolume = opts?.volume ?? 100;
  currentId = id;
  currentUrl = url;
  endedCb = opts?.onEnded ?? null;
  pausedOffset = null;
  startSource(c, buffer, 0);
  return buffer.duration;
}

export function setVolume(volume: number): void {
  const b = hostBackend();
  if (b) {
    b.setVolume(volume);
    return;
  }
  currentVolume = volume;
  if (gain) gain.gain.value = volume / 100;
}

export function getCurrentTime(): number {
  const b = hostBackend();
  if (b) return b.getCurrentTime();
  const c = getCtx();
  if (!c || !source) return pausedOffset ?? 0; // paused(소스 없음)면 멈춘 위치 유지
  return Math.min(currentDuration, startedAtOffset + (c.currentTime - startedAtCtxTime));
}

// Pause/resume: 정지(stop)와 달리 위치를 보존해 이어서 재생. Premiere(video/sourceMonitor 백엔드)는
// 네이티브로, web(AudioContext)는 현재 offset 을 기억했다가 그 지점에서 재시작.
export function pause(): void {
  const b = hostBackend();
  if (b) {
    b.pause();
    return;
  }
  const c = getCtx();
  if (!c || !source) return;
  pausedOffset = Math.min(currentDuration, startedAtOffset + (c.currentTime - startedAtCtxTime));
  teardownSource();
}

export async function resume(): Promise<void> {
  const b = hostBackend();
  if (b) {
    b.resume();
    return;
  }
  const c = getCtx();
  if (!c || currentUrl == null || pausedOffset == null) return;
  const buffer = bufferCache.get(currentUrl);
  if (!buffer) return;
  startSource(c, buffer, pausedOffset);
  pausedOffset = null;
}

// Jump to a position (0..1) within the currently playing clip.
export function seek(ratio: number): void {
  const b = hostBackend();
  if (b) {
    b.seek(ratio);
    return;
  }
  const c = getCtx();
  if (!c || !source || !currentUrl) return;
  const buffer = bufferCache.get(currentUrl);
  if (!buffer) return;
  teardownSource();
  startSource(c, buffer, ratio * buffer.duration);
}
