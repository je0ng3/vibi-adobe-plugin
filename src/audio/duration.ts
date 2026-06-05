// Pure-JS duration probing for compressed inputs (mp3 / m4a) that UXP can't decode via Web
// Audio. We only need the length in seconds (for the credit cost and to clear the
// "Reading audio…" state) — not the samples. Returns null if the format isn't recognized.

export function probeDurationSec(bytes: ArrayBuffer): number | null {
  const b = new Uint8Array(bytes);
  if (b.length < 12) return null;
  // "ftyp" at offset 4 → ISO base media (mp4/m4a)
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return mp4Duration(b);
  // "ID3" tag or 0xFFEx frame sync → mp3
  if ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
    return mp3Duration(b);
  }
  return null;
}

// ---------- mp4 / m4a (read moov → mvhd) ----------
function mp4Duration(b: Uint8Array): number | null {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

  function findBox(start: number, end: number, type: string): [number, number] | null {
    let o = start;
    while (o + 8 <= end) {
      let size = view.getUint32(o);
      let header = 8;
      if (size === 1) {
        // 64-bit size: high 32 bits are 0 for any realistic file
        const hi = view.getUint32(o + 8);
        const lo = view.getUint32(o + 12);
        size = hi * 0x100000000 + lo;
        header = 16;
      }
      if (size === 0) size = end - o; // box extends to end
      if (size < header) return null;
      const t = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (t === type) return [o + header, o + size];
      o += size;
    }
    return null;
  }

  const moov = findBox(0, b.length, "moov");
  if (!moov) return null;
  const mvhd = findBox(moov[0], moov[1], "mvhd");
  if (!mvhd) return null;

  const p = mvhd[0];
  const version = b[p];
  // after version(1)+flags(3):
  if (version === 1) {
    const timescale = view.getUint32(p + 4 + 16); // skip 2× 8-byte times
    const hi = view.getUint32(p + 4 + 20);
    const lo = view.getUint32(p + 4 + 24);
    const duration = hi * 0x100000000 + lo;
    return timescale > 0 ? duration / timescale : null;
  }
  const timescale = view.getUint32(p + 4 + 8); // skip 2× 4-byte times
  const duration = view.getUint32(p + 4 + 12);
  return timescale > 0 ? duration / timescale : null;
}

// ---------- mp3 (Xing/Info VBR header, else CBR estimate) ----------
const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_SAMPLERATES_V1 = [44100, 48000, 32000, 0];
const MP3_SAMPLERATES_V2 = [22050, 24000, 16000, 0];
const MP3_SAMPLERATES_V25 = [11025, 12000, 8000, 0];

function mp3Duration(b: Uint8Array): number | null {
  let offset = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    // ID3v2: 4-byte synchsafe size at offset 6
    const size = (b[6] & 0x7f) * 0x200000 + (b[7] & 0x7f) * 0x4000 + (b[8] & 0x7f) * 0x80 + (b[9] & 0x7f);
    offset = 10 + size;
  }
  // Find the first frame sync
  while (offset + 4 < b.length && !(b[offset] === 0xff && (b[offset + 1] & 0xe0) === 0xe0)) offset++;
  if (offset + 4 >= b.length) return null;

  const h1 = b[offset + 1];
  const h2 = b[offset + 2];
  const versionBits = (h1 >> 3) & 0x3; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (h1 >> 1) & 0x3; // 1=Layer3
  if (layerBits !== 1) return null; // only Layer III matters here

  const isV1 = versionBits === 3;
  const bitrate = (isV1 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[(h2 >> 4) & 0xf] * 1000;
  const sampleRate = (
    versionBits === 3 ? MP3_SAMPLERATES_V1 : versionBits === 2 ? MP3_SAMPLERATES_V2 : MP3_SAMPLERATES_V25
  )[(h2 >> 2) & 0x3];
  if (!sampleRate) return null;
  const samplesPerFrame = isV1 ? 1152 : 576;

  // Xing/Info header → exact frame count
  const channelMode = (b[offset + 3] >> 6) & 0x3;
  const sideInfo = isV1 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
  const xo = offset + 4 + sideInfo;
  const tag =
    xo + 4 <= b.length ? String.fromCharCode(b[xo], b[xo + 1], b[xo + 2], b[xo + 3]) : "";
  if (tag === "Xing" || tag === "Info") {
    const flags = b[xo + 7];
    if (flags & 0x1) {
      const fc = xo + 8;
      const frameCount = b[fc] * 0x1000000 + b[fc + 1] * 0x10000 + b[fc + 2] * 0x100 + b[fc + 3];
      return (frameCount * samplesPerFrame) / sampleRate;
    }
  }

  // CBR estimate from remaining byte length
  if (!bitrate) return null;
  const audioBytes = b.length - offset;
  return (audioBytes * 8) / bitrate;
}
