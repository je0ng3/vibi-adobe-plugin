import { storage } from "uxp";

// Perso audio separation only reliably handles these. FLAC uploads but silently fails
// the job (KNOWN_ISSUES.md); OGG/AAC are unverified. Keep in sync with the server's
// AUDIO_EXTS whitelist in src/host/premiere.ts.
export const SUPPORTED_EXTS = ["mp3", "wav", "m4a"];

export interface LoadedAudioSource {
  bytes: ArrayBuffer;
  fileName: string;
  ext: string;
  byteLength: number;
}

interface Entry {
  name: string;
  read: (opts: { format: unknown }) => Promise<ArrayBuffer>;
}

export async function pickAudiosFromOs(): Promise<LoadedAudioSource[]> {
  const result = await storage.localFileSystem.getFileForOpening({
    types: SUPPORTED_EXTS,
    allowMultiple: true,
  });
  if (!result) return [];
  const entries: Entry[] = Array.isArray(result)
    ? (result as unknown as Entry[])
    : [result as unknown as Entry];
  return Promise.all(entries.map((e) => readEntry(e)));
}

async function readEntry(entry: Entry): Promise<LoadedAudioSource> {
  const ext = (entry.name.split(".").pop() ?? "").toLowerCase();
  const bytes = await entry.read({ format: storage.formats.binary });
  return { bytes, fileName: entry.name, ext, byteLength: bytes.byteLength };
}
