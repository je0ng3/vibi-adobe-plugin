// Perso audio separation/translate only reliably handles these. FLAC uploads but the job
// never finishes (polls to progress=100/"Failed" after the full 30-min timeout — see
// KNOWN_ISSUES.md); OGG/AAC are unverified. The client already guards (src/host/premiere.ts,
// src/input/audioPicker.ts) but a direct API call or a client bug must be rejected here too.
const ACCEPTED_AUDIO_EXTS = new Set(["mp3", "wav", "m4a"]);

export function isAcceptedAudioName(fileName: string): boolean {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  return ACCEPTED_AUDIO_EXTS.has(ext);
}

export const ACCEPTED_AUDIO_LABEL = [...ACCEPTED_AUDIO_EXTS].join("/");
