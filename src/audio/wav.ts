// Pure-JS WAV PCM handling — no Web Audio. UXP's AudioContext/OfflineAudioContext are
// unreliable (KNOWN_ISSUES), which broke waveform peaks and stem mixing. Separation stems
// and the mix are WAV, so we parse/encode PCM directly and only fall back to Web Audio for
// compressed inputs (mp3/m4a) that genuinely need a decoder.

export interface PcmAudio {
  channels: Float32Array[]; // per-channel samples, normalized to -1..1
  sampleRate: number;
  length: number; // frames per channel
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function isWav(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false;
  const v = new DataView(bytes);
  return readTag(v, 0) === "RIFF" && readTag(v, 8) === "WAVE";
}

type SampleReader = (pos: number) => number;

function makeSampleReader(v: DataView, audioFormat: number, bits: number): SampleReader | null {
  if (audioFormat === 3) {
    // IEEE float
    if (bits === 32) return (p) => v.getFloat32(p, true);
    if (bits === 64) return (p) => v.getFloat64(p, true);
    return null;
  }
  // PCM integer (1) or WAVE_FORMAT_EXTENSIBLE (0xFFFE, assume PCM int)
  if (bits === 8) return (p) => (v.getUint8(p) - 128) / 128; // 8-bit is unsigned
  if (bits === 16) return (p) => v.getInt16(p, true) / 0x8000;
  if (bits === 24)
    return (p) => {
      const val = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
      return (val & 0x800000 ? val - 0x1000000 : val) / 0x800000;
    };
  if (bits === 32) return (p) => v.getInt32(p, true) / 0x80000000;
  return null;
}

export function parseWav(bytes: ArrayBuffer): PcmAudio | null {
  if (!isWav(bytes)) return null;
  const v = new DataView(bytes);
  let fmt: { audioFormat: number; numChannels: number; sampleRate: number; bitsPerSample: number } | null =
    null;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= v.byteLength) {
    const id = readTag(v, offset);
    const size = v.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: v.getUint16(body, true),
        numChannels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bitsPerSample: v.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2); // chunks are word-aligned (pad byte if odd)
  }

  if (!fmt || dataOffset < 0 || fmt.numChannels < 1) return null;
  const { numChannels, sampleRate, bitsPerSample, audioFormat } = fmt;
  const read = makeSampleReader(v, audioFormat, bitsPerSample);
  if (!read) return null;

  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = bytesPerSample * numChannels;
  const available = Math.min(dataSize, v.byteLength - dataOffset);
  const frames = Math.floor(available / blockAlign);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    const frameStart = dataOffset + i * blockAlign;
    for (let ch = 0; ch < numChannels; ch++) {
      channels[ch][i] = read(frameStart + ch * bytesPerSample);
    }
  }
  return { channels, sampleRate, length: frames };
}

// Downsample one channel to `barCount` normalized peak heights (0..1).
export function computePeaks(data: Float32Array, barCount: number): Float32Array {
  const bucket = Math.max(1, Math.floor(data.length / barCount));
  const peaks = new Float32Array(barCount);
  let maxOverall = 0;
  for (let i = 0; i < barCount; i++) {
    let max = 0;
    const start = i * bucket;
    const end = Math.min(start + bucket, data.length);
    for (let j = start; j < end; j++) {
      const a = Math.abs(data[j]);
      if (a > max) max = a;
    }
    peaks[i] = max;
    if (max > maxOverall) maxOverall = max;
  }
  if (maxOverall > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= maxOverall;
  return peaks;
}

// Encode float channels to a 16-bit PCM WAV.
export function encodeWavPcm16(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  const numChannels = Math.max(1, channels.length);
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}
