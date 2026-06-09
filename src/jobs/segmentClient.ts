import { parseWav, encodeWavPcm16 } from "../audio/wav";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

// Isolate one speaker from the original audio by time, entirely in the panel (pure JS, no
// server). Keeps the audio only during that speaker's segments and mutes everything else,
// preserving the original length/timing so the result lines up on a Premiere track. With no
// ranges the whole track is silenced. Mirrors the old server ffmpeg path
// (`volume=enable='not(between(...))':volume=0`).
//
// Input is always a 44.1k/stereo/16-bit WAV here — either a single transcoded voice stem or a
// local mix (see audio/mixer.ts) — so parseWav handles it; UXP needs no decoder. Doing this in
// the panel removes the /api/v2/segment endpoint (and its upload) from the server.
export async function segmentSpeaker(audioBytes: ArrayBuffer, ranges: TimeRange[]): Promise<ArrayBuffer> {
  const pcm = parseWav(audioBytes);
  if (!pcm) throw new Error("source is not WAV PCM");

  const { channels, sampleRate, length } = pcm;

  // Per-sample keep mask over the full length. A frame is kept if its time falls in any range;
  // mute (0) otherwise — preserving timing exactly like the ffmpeg `between(t,...)` enable.
  const keep = new Uint8Array(length);
  for (const r of ranges) {
    if (r.endMs <= r.startMs) continue;
    const start = Math.max(0, Math.round((r.startMs / 1000) * sampleRate));
    const end = Math.min(length, Math.round((r.endMs / 1000) * sampleRate));
    for (let i = start; i < end; i++) keep[i] = 1;
  }

  const out: Float32Array[] = channels.map((src) => {
    const dst = new Float32Array(length);
    for (let i = 0; i < length; i++) if (keep[i]) dst[i] = src[i];
    return dst;
  });

  return encodeWavPcm16(out, sampleRate);
}
