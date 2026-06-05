// Web Audio playback engine. UXP's <audio> element has no working play()/pause()
// (KNOWN_ISSUES), and the native Premiere preview engine is not reachable from a UXP panel.
// Web Audio (AudioContext + AudioBufferSourceNode) is the only in-panel playback path — and
// only when the runtime provides AudioContext (the same API the waveform decoder uses). When
// it is absent, playbackSupported() is false and the UI hides the play buttons.
//
// A single shared context plays one clip at a time (preview semantics). A GainNode lets the
// volume fader affect playback live. Buffers are cached per URL so re-play is instant.

import { parseWav } from "./wav";
import { audioUrlToBytes } from "./audioUrl";

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
  return audioContextCtor() != null;
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

export function playingId(): string | null {
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
  teardownSource();
  currentId = null;
  currentUrl = null;
  endedCb = null;
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
  opts?: { volume?: number; onEnded?: () => void },
): Promise<number> {
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
  startSource(c, buffer, 0);
  return buffer.duration;
}

export function setVolume(volume: number): void {
  currentVolume = volume;
  if (gain) gain.gain.value = volume / 100;
}

export function getCurrentTime(): number {
  const c = getCtx();
  if (!c || !source) return 0;
  return Math.min(currentDuration, startedAtOffset + (c.currentTime - startedAtCtxTime));
}

// Jump to a position (0..1) within the currently playing clip.
export function seek(ratio: number): void {
  const c = getCtx();
  if (!c || !source || !currentUrl) return;
  const buffer = bufferCache.get(currentUrl);
  if (!buffer) return;
  teardownSource();
  startSource(c, buffer, ratio * buffer.duration);
}
