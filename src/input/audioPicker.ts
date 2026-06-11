import { storage } from "uxp";
import { VIDEO_EXTS, isVideoExt, convertVideoToAudio } from "../host/encoder";

// Perso audio separation only reliably handles these. FLAC uploads but silently fails
// the job (KNOWN_ISSUES.md); OGG/AAC are unverified. Keep in sync with the server's
// AUDIO_EXTS whitelist in src/host/premiere.ts.
export const SUPPORTED_EXTS = ["mp3", "wav", "m4a"];

// What the OS file dialog accepts: real audio (uploaded as-is) plus video containers whose
// audio track we extract to MP3 locally before separation (see host/encoder.ts).
export const PICKER_EXTS = [...SUPPORTED_EXTS, ...VIDEO_EXTS];

export interface LoadedAudioSource {
  bytes: ArrayBuffer;
  fileName: string;
  ext: string;
  byteLength: number;
  // Sequence-relative start time (seconds) of the timeline clip this was read from, when added
  // via the Timeline source. Lets a generated mix drop back at the original clip's position; for
  // File/Project sources it's undefined and the mix lands at the playhead instead.
  timelineStartSec?: number;
}

interface Entry {
  name: string;
  nativePath: string;
  read: (opts: { format: unknown }) => Promise<ArrayBuffer>;
}

export interface PickOptions {
  onStatus?: (message: string) => void;
}

export async function pickAudiosFromOs(opts: PickOptions = {}): Promise<LoadedAudioSource[]> {
  const result = await storage.localFileSystem.getFileForOpening({
    types: PICKER_EXTS,
    allowMultiple: true,
  });
  if (!result) return [];
  const entries: Entry[] = Array.isArray(result)
    ? (result as unknown as Entry[])
    : [result as unknown as Entry];
  // Sequentially so the AME queue handles one extraction at a time and status reads cleanly.
  const out: LoadedAudioSource[] = [];
  for (const e of entries) out.push(await readEntry(e, opts));
  return out;
}

async function readEntry(entry: Entry, opts: PickOptions): Promise<LoadedAudioSource> {
  const ext = (entry.name.split(".").pop() ?? "").toLowerCase();
  // A video pick: extract its audio track to MP3 from the file path — never read the (huge)
  // video bytes into memory.
  if (isVideoExt(ext)) {
    return convertVideoToAudio(entry.nativePath, { onStatus: opts.onStatus });
  }
  const bytes = await entry.read({ format: storage.formats.binary });
  return { bytes, fileName: entry.name, ext, byteLength: bytes.byteLength };
}
