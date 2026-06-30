export interface SelectionRange {
  startRatio: number;
  endRatio: number;
}

export interface Speaker {
  index: number;
  label: string;
}

export interface TranscriptSegment {
  id: string;
  speakerIndex: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface ScriptDraft {
  speakers: Speaker[];
  segments: TranscriptSegment[];
}

// Display labels are English and consistent across the stem list and the script editor, so a
// speaker reads the same name in both places (and "Speaker 1" lines up with the "speaker_1" stem).
export function defaultSpeakerLabel(index: number): string {
  return `Speaker ${index}`;
}

// A blank label or a generic auto-name — our English default, the old Korean "화자 N", or the
// backend's "speaker_N" — carries no user intent, so it's replaced with the canonical English name.
// A genuinely renamed label (anything else) is kept as-is.
// 화자 = "화자"; escaped rather than written literally because UXP's JS parser chokes on
// non-ASCII characters inside a regex literal ("Invalid regular expression: missing /").
const AUTO_LABEL_RE = /^\s*(?:speaker|\uD654\uC790)[\s_]*\d*\s*$/i;
export function isAutoSpeakerLabel(label: string | null | undefined): boolean {
  return !label || AUTO_LABEL_RE.test(label);
}

// Canonical English label for a separated stem, derived from its server stemId so the background
// track and each voice read consistently regardless of how the backend named them, and so a stem
// lines up with the same-numbered script speaker. An unknown id keeps a meaningful server label,
// else falls back to the id itself.
export function stemDisplayLabel(stemId: string, serverLabel?: string): string {
  if (stemId === "background") return "Background";
  // Server stems are 0-based ("speaker_0"), but the script numbers speakers from 1 — shift +1 so
  // "speaker_0" reads "Speaker 1" and matches the script.
  let m = /^speaker_(\d+)$/i.exec(stemId);
  if (m) return defaultSpeakerLabel(Number(m[1]) + 1);
  // Client re-cut stems ("spk-N") already carry the 1-based script index, so keep N as-is.
  m = /^spk-(\d+)$/i.exec(stemId);
  if (m) return defaultSpeakerLabel(Number(m[1]));
  return serverLabel && !isAutoSpeakerLabel(serverLabel) ? serverLabel : stemId;
}
