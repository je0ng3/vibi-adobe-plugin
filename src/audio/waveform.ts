import { parseWav, computePeaks } from "./wav";
import { probeDurationSec } from "./duration";
import { formatClock } from "./format";

const DEFAULT_BAR_COUNT = 200;

// "ok" = real decode; "no-audiocontext" = Web Audio unavailable (UXP), peaks are mock but
// the file may be perfectly valid; "failed" = decodeAudioData rejected, i.e. the input is
// genuinely unreadable. Callers that care about input validity (the prepare step) treat
// "failed" as an error; stem/mix previews can ignore it and show mock bars.
export type DecodeStatus = "ok" | "no-audiocontext" | "failed";

export interface DecodedAudio {
  peaks: Float32Array;
  durationSec: number;
  status: DecodeStatus;
}

export async function decodeAndComputePeaks(
  bytes: ArrayBuffer,
  barCount: number = DEFAULT_BAR_COUNT,
): Promise<DecodedAudio> {
  // Prefer the pure-JS WAV path — works without Web Audio, which covers separation stems,
  // the mix, and WAV inputs (the cases that were showing mock/garbage peaks in UXP).
  const pcm = parseWav(bytes);
  if (pcm && pcm.length > 0) {
    return {
      peaks: computePeaks(pcm.channels[0], barCount),
      durationSec: pcm.length / pcm.sampleRate,
      status: "ok",
    };
  }

  // Compressed inputs (mp3/m4a) need a real decoder → Web Audio, if the runtime has it.
  const Ctor = getAudioContextCtor();
  if (Ctor) {
    const ctx = new Ctor();
    try {
      const copy = bytes.slice(0);
      const buffer = await ctx.decodeAudioData(copy);
      const data = buffer.getChannelData(0);
      return { peaks: downsample(data, barCount), durationSec: buffer.duration, status: "ok" };
    } catch (e) {
      console.warn("[waveform] decode failed:", e);
    } finally {
      if (ctx.state !== "closed") void ctx.close().catch(() => {});
    }
  }

  // No Web Audio (or decode failed): we can't render real bars for mp3/m4a, but we can still
  // read the duration straight from the container so the cost shows and the UI stops saying
  // "Reading audio…". Show a flat placeholder rather than misleading random bars.
  const durationSec = probeDurationSec(bytes) ?? 0;
  return { peaks: flatPeaks(barCount), durationSec, status: "no-audiocontext" };
}

// A low, even baseline — reads as "no preview available", not as fake audio content.
function flatPeaks(barCount: number): Float32Array {
  return new Float32Array(barCount).fill(0.12);
}

function getAudioContextCtor(): typeof AudioContext | null {
  const w = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function downsample(data: Float32Array, barCount: number): Float32Array {
  const bucket = Math.max(1, Math.floor(data.length / barCount));
  const peaks = new Float32Array(barCount);
  let maxOverall = 0;
  for (let i = 0; i < barCount; i++) {
    let max = 0;
    const start = i * bucket;
    const end = Math.min(start + bucket, data.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks[i] = max;
    if (max > maxOverall) maxOverall = max;
  }
  if (maxOverall > 0) {
    for (let i = 0; i < peaks.length; i++) peaks[i] /= maxOverall;
  }
  return peaks;
}

export function slicePeaks(peaks: Float32Array, startRatio: number, endRatio: number): Float32Array {
  const len = peaks.length;
  const s = Math.max(0, Math.min(1, startRatio));
  const e = Math.max(s, Math.min(1, endRatio));
  const startIdx = Math.floor(s * len);
  const endIdx = Math.ceil(e * len);
  return peaks.slice(startIdx, endIdx);
}

export function ratioToTime(ratio: number, durationSec: number): string {
  return formatClock(Math.max(0, ratio) * durationSec, { padMinutes: true });
}

