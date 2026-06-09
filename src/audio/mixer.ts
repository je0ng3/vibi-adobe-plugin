import { parseWav, encodeWavPcm16 } from "./wav";
import { audioUrlToBytes } from "./audioUrl";

export interface MixSource {
  audioUrl: string;
  volume: number; // percent; 100 = unity
}

// Mix selected stems entirely in the panel (pure JS, no server round-trip). Every stem that
// reaches here is a uniform 44.1kHz / stereo / 16-bit PCM WAV — the server normalizes each
// stem via transcodeToWav at separation/store time — so we can decode PCM, apply per-stem
// gain, sum, and re-encode without any resampling or format alignment. This mirrors the old
// server ffmpeg path (`amix=normalize=0:duration=longest`): straight sum, clip at encode.
//
// UXP has no Web Audio, so we rely on the pure-JS parseWav/encodeWavPcm16 in ./wav. Doing it
// locally removes the /api/v2/mix endpoint (and its up-to-400MB upload) from the server.
export async function mixStems(sources: MixSource[]): Promise<ArrayBuffer> {
  if (sources.length === 0) throw new Error("no stems selected");

  const decoded = await Promise.all(
    sources.map(async (s) => {
      const pcm = parseWav(await audioUrlToBytes(s.audioUrl));
      if (!pcm) throw new Error("stem is not WAV PCM");
      // Match the server clamp: 0..1.5 of unity (volume=g in the old amix filter).
      return { pcm, gain: Math.min(1.5, Math.max(0, s.volume / 100)) };
    }),
  );

  const sampleRate = decoded[0].pcm.sampleRate;
  const numChannels = decoded.reduce((m, d) => Math.max(m, d.pcm.channels.length), 1);
  const frames = decoded.reduce((m, d) => Math.max(m, d.pcm.length), 0); // duration=longest

  const out: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) out.push(new Float32Array(frames));

  for (const { pcm, gain } of decoded) {
    for (let ch = 0; ch < numChannels; ch++) {
      // Upmix: a stem with fewer channels (mono) feeds every output channel from channel 0.
      const src = pcm.channels[ch] ?? pcm.channels[0];
      const acc = out[ch];
      for (let i = 0; i < pcm.length; i++) acc[i] += src[i] * gain;
    }
  }

  // encodeWavPcm16 clamps each sample to [-1, 1] — the sum-then-clip of normalize=0.
  return encodeWavPcm16(out, sampleRate);
}
