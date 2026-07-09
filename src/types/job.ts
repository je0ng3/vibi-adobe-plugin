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

// Default speaker name = just the number. The colored dot/tag (script) and the "Speakers" group
// header (stem list) already convey that these are speakers, so spelling out "Speaker" would only
// repeat that; the bare index reads the same in both places and lines up with the "speaker_N" stem.
// Newly added speakers get their number here too (ScriptEditor's addSpeaker uses this).
export function defaultSpeakerLabel(index: number): string {
  return `${index}`;
}

// A blank label or a generic auto-name — our English default, the old Korean "화자 N", or the
// backend's "speaker_N" — carries no user intent, so it's replaced with the canonical English name.
// A genuinely renamed label (anything else) is kept as-is.
// 화자 = "화자"; escaped rather than written literally because UXP's JS parser chokes on
// non-ASCII characters inside a regex literal ("Invalid regular expression: missing /").
// The speaker/\uD654\uC790 prefix is optional so a bare number (our new default, e.g. "1") also counts as auto.
const AUTO_LABEL_RE = /^\s*(?:speaker|\uD654\uC790)?[\s_]*\d*\s*$/i;
export function isAutoSpeakerLabel(label: string | null | undefined): boolean {
  return !label || AUTO_LABEL_RE.test(label);
}

// True for either background variant — the pure BGM ("background") or the reaction-included one
// ("background_reaction"). Voice-only operations (script re-cut, vocals mix) must exclude both so a
// background track is never treated as a speaker.
export function isBackgroundStemId(stemId: string): boolean {
  return stemId === "background" || stemId === "background_reaction";
}

// Which stems start selected in the mix. First speaker + the reaction-free background make a
// usable default mix; the reaction background is a mutually-exclusive alternative left off so at
// most one background is ever selected. `orderIndex` is the stem's position among the shown stems.
export function isDefaultSelectedStem(stemId: string, orderIndex: number): boolean {
  if (stemId === "background") return true;
  if (stemId === "background_reaction") return false;
  return orderIndex === 0;
}

// Short label shown INSIDE a stem group, where the group header ("Speakers"/"Background") already
// supplies the category. Speakers collapse to just their (1-based) number; the two background
// variants to the phrase that tells them apart. Returns null for an unrecognized stem so the caller
// falls back to the full `stemDisplayLabel`. The full name still lives in the hover tooltip.
export function stemGroupLabel(stemId: string): string | null {
  if (stemId === "background") return "No reaction";
  if (stemId === "background_reaction") return "With reaction";
  let m = /^speaker_(\d+)$/i.exec(stemId);
  if (m) return String(Number(m[1]) + 1); // server stems are 0-based; script numbers from 1
  m = /^spk-(\d+)$/i.exec(stemId);
  if (m) return String(Number(m[1])); // client re-cut stems already carry the 1-based index
  return null;
}

// Canonical English label for a separated stem, derived from its server stemId so the background
// track and each voice read consistently regardless of how the backend named them, and so a stem
// lines up with the same-numbered script speaker. An unknown id keeps a meaningful server label,
// else falls back to the id itself.
export function stemDisplayLabel(stemId: string, serverLabel?: string): string {
  // Two background variants ship side by side so the user can pick one (or mix both): the pure BGM
  // and the one that keeps reactions (effects, ad-libs, non-primary speakers). Disambiguate both.
  if (stemId === "background") return "Background (no reaction)";
  if (stemId === "background_reaction") return "Background (with reaction)";
  // Server stems are 0-based ("speaker_0"), but the script numbers speakers from 1 — shift +1 so
  // "speaker_0" reads "Speaker 1" and matches the script.
  let m = /^speaker_(\d+)$/i.exec(stemId);
  if (m) return defaultSpeakerLabel(Number(m[1]) + 1);
  // Client re-cut stems ("spk-N") already carry the 1-based script index, so keep N as-is.
  m = /^spk-(\d+)$/i.exec(stemId);
  if (m) return defaultSpeakerLabel(Number(m[1]));
  return serverLabel && !isAutoSpeakerLabel(serverLabel) ? serverLabel : stemId;
}
