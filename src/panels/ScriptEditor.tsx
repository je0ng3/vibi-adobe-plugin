import { useEffect, useMemo, useRef, useState } from "react";
import type { ScriptDraft, Speaker, TranscriptSegment } from "../types/job";
import { defaultSpeakerLabel, isAutoSpeakerLabel } from "../types/job";
import { formatClock } from "../audio/format";

interface Props {
  draft: ScriptDraft;
  busy: boolean;
  onChange: (draft: ScriptDraft) => void;
  onRegenerate: () => void;
}

// Per-speaker colors — a bright green / blue / pink trio at matched saturation. They're light enough
// that the tag text is dark (see .seg-tag) rather than white to stay legible. A speaker reads the same
// color in the list and in every line tag; past the third speaker the palette wraps.
const SPEAKER_COLORS = ["#44C68A", "#4FA8FF", "#F06A8A"];
const colorFor = (index: number) => SPEAKER_COLORS[Math.abs(index) % SPEAKER_COLORS.length];

// The speaker tags all share one width — sized to fit the *longest* speaker name so every tag is
// the same size (and the dialogue still starts at the same x), capped at 84px so a very long name
// ellipsizes instead of shoving the dialogue off-screen. UXP can't measure text, so estimate from
// character widths at 11px/600: CJK glyphs ~12px, everything else ~6.5px, plus the tag's padding.
const TAG_MAX_WIDTH = 84;
function tagWidthFor(speakers: Speaker[]): number {
  // Wide (CJK etc.) glyphs sit above the Latin-1 block (code point > 0xFF); count them ~12px.
  const widthOf = (label: string) =>
    [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0xff ? 12 : 6.5), 0);
  const widest = speakers.reduce(
    (max, sp) => Math.max(max, widthOf(sp.label || defaultSpeakerLabel(sp.index))),
    0,
  );
  return Math.min(TAG_MAX_WIDTH, Math.ceil(widest) + 16); // +16 for 8px padding either side
}

function formatMs(ms: number): string {
  return formatClock(ms / 1000, { padMinutes: true });
}

// Parse a user-typed time into ms. Accepts "mm:ss", "mm:ss.s", or bare seconds ("9.5").
function parseTimeToMs(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  let sec: number;
  if (t.includes(":")) {
    const [m, s] = t.split(":");
    const mins = parseInt(m, 10);
    const secs = parseFloat(s);
    if (Number.isNaN(mins) || Number.isNaN(secs)) return null;
    sec = mins * 60 + secs;
  } else {
    sec = parseFloat(t);
    if (Number.isNaN(sec)) return null;
  }
  return Math.round(sec * 1000);
}

// Controlled inline editor: the working draft lives in the parent (FileCard) so the panel can be
// collapsed/expanded without losing edits. Edit lines like a text editor — type to fix the text,
// press Enter mid-line to split a line in two (the split time is interpolated from where the caret
// sits in the text), and Backspace at the very start of a line to merge it back into the line above.
// The start time of each line is tappable for fine-tuning, since the caret-ratio split is only an
// estimate. Rename / add / remove speakers and reassign a line by tapping its colored tag.
// (No <select>/<textarea> — UXP doesn't render those reliably; plain <input> is fine.)
export function ScriptEditor({ draft, busy, onChange, onRegenerate }: Props) {
  const canRemove = draft.speakers.length > 1;
  // Which line's time is being edited, which end of it (start/end), and the typed value. Local UI state.
  const [editTimeId, setEditTimeId] = useState<string | null>(null);
  const [editTimeKind, setEditTimeKind] = useState<"start" | "end">("start");
  const [timeInput, setTimeInput] = useState("");
  // Which line's speaker picker is open (tap the tag → list of speakers → choose).
  const [pickerSegId, setPickerSegId] = useState<string | null>(null);

  // After a split/merge we want the caret to land in the right line at the join point. We keep refs
  // to each line's text input and apply the focus once the draft has re-rendered.
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [pendingFocus, setPendingFocus] = useState<{ id: string; offset: number } | null>(null);
  useEffect(() => {
    if (!pendingFocus) return;
    const el = inputRefs.current[pendingFocus.id];
    if (el) {
      el.focus();
      try {
        el.setSelectionRange(pendingFocus.offset, pendingFocus.offset);
      } catch {
        /* selection API may be unavailable; focus alone is enough */
      }
    }
    setPendingFocus(null);
  }, [draft.segments]);


  // The line tags share one width that tracks the longest speaker name; recompute it whenever the
  // speaker set actually changes (a committed rename, or add/remove). It is NOT recomputed mid-edit
  // because a rename only commits on blur (see the speaker-name input) — so there's no per-keystroke
  // relayout to fight.
  const tagWidth = useMemo(
    () => tagWidthFor(draft.speakers),
    [draft.speakers]
  )

  function renameSpeaker(index: number, label: string) {
    onChange({
      ...draft,
      speakers: draft.speakers.map((sp) =>
        sp.index === index
          ? { ...sp, label }
          : sp
      ),
    });
  }

  function addSpeaker() {
    const nextIndex = draft.speakers.reduce((m, sp) => Math.max(m, sp.index), 0) + 1;
    onChange({ ...draft, speakers: [...draft.speakers, { index: nextIndex, label: defaultSpeakerLabel(nextIndex) }] });
  }

  function removeSpeaker(index: number) {
    if (draft.speakers.length <= 1) return;
    const remaining = draft.speakers.filter((sp) => sp.index !== index);
    const fallback = remaining[0].index;
    onChange({
      ...draft,
      speakers: remaining,
      segments: draft.segments.map((seg) => (seg.speakerIndex === index ? { ...seg, speakerIndex: fallback } : seg)),
    });
  }

  // Tap a line's speaker tag to open a list of speakers, then pick one to reassign that line.
  function assignSpeaker(seg: TranscriptSegment, speakerIndex: number) {
    if (speakerIndex !== seg.speakerIndex) {
      onChange({ ...draft, segments: draft.segments.map((s) => (s.id === seg.id ? { ...s, speakerIndex } : s)) });
    }
    setPickerSegId(null);
  }

  function setSegmentText(seg: TranscriptSegment, text: string) {
    onChange({ ...draft, segments: draft.segments.map((s) => (s.id === seg.id ? { ...s, text } : s)) });
  }

  // Split one line at the caret into two. The split time is interpolated from the caret's position
  // in the text (caret / length of its time span) — there's no per-character timing, so the text
  // length is the best proxy. The first half keeps the text before the caret, the second the rest;
  // both stay on the same speaker until the user taps the new line's tag. Caret lands at the start
  // of the second line so typing flows on.
  function splitAtCaret(seg: TranscriptSegment, caret: number) {
    const len = seg.text.length;
    if (caret <= 0 || caret >= len) return; // nothing meaningful to split off
    const ratio = caret / len;
    let atMs = Math.round(seg.startMs + ratio * (seg.endMs - seg.startMs));
    atMs = Math.min(Math.max(atMs, seg.startMs + 1), seg.endMs - 1);
    const first: TranscriptSegment = { ...seg, endMs: atMs, text: seg.text.slice(0, caret) };
    const secondId = `${seg.id}-s${atMs}`;
    const second: TranscriptSegment = { ...seg, id: secondId, startMs: atMs, text: seg.text.slice(caret) };
    onChange({ ...draft, segments: draft.segments.flatMap((s) => (s.id === seg.id ? [first, second] : [s])) });
    setPendingFocus({ id: secondId, offset: 0 });
  }

  // Merge a line into the one above it: the previous line's audio is extended to cover this line's
  // span and the texts are joined. Speaker of the previous line wins (we merge regardless of who
  // spoke). The caret lands at the seam. No-op on the first line (nothing above to merge into).
  function mergeIntoPrev(seg: TranscriptSegment) {
    const idx = draft.segments.findIndex((s) => s.id === seg.id);
    if (idx <= 0) return;
    const prev = draft.segments[idx - 1];
    const merged: TranscriptSegment = { ...prev, endMs: seg.endMs, text: prev.text + seg.text };
    const segments = draft.segments
      .filter((_, i) => i !== idx)
      .map((s) => (s.id === prev.id ? merged : s));
    onChange({ ...draft, segments });
    setPendingFocus({ id: prev.id, offset: prev.text.length });
  }

  function onTextKeyDown(e: React.KeyboardEvent<HTMLInputElement>, seg: TranscriptSegment) {
    const el = e.currentTarget;
    if (e.key === "Enter") {
      e.preventDefault();
      const caret = el.selectionStart ?? seg.text.length;
      splitAtCaret(seg, caret);
      return;
    }
    if (e.key === "Backspace" && el.selectionStart === 0 && el.selectionEnd === 0) {
      e.preventDefault();
      mergeIntoPrev(seg);
    }
  }

  function openTime(seg: TranscriptSegment, kind: "start" | "end") {
    setTimeInput(formatMs(kind === "start" ? seg.startMs : seg.endMs));
    setEditTimeKind(kind);
    setEditTimeId(seg.id);
  }

  // Commit an edited time. Only THIS line moves — a neighbour's used time is a hard wall, never
  // dragged along, so a line can only be resized within the room it actually has:
  //   • start ∈ [previous line's end … this line's end − 1]  (0 if it's the first line)
  //   • end   ∈ [this line's start + 1 … next line's start]  (open above if it's the last line)
  // Values outside that range clamp to the nearest edge, so you can never overlap an adjacent line.
  function commitTime(seg: TranscriptSegment) {
    const atMs = parseTimeToMs(timeInput);
    const kind = editTimeKind;
    setEditTimeId(null);
    if (atMs === null) return;
    const idx = draft.segments.findIndex((s) => s.id === seg.id);
    if (kind === "start") {
      const prev = idx > 0 ? draft.segments[idx - 1] : null;
      const lower = prev ? prev.endMs : 0;
      const upper = seg.endMs - 1;
      const clamped = Math.min(Math.max(atMs, lower), upper);
      onChange({
        ...draft,
        segments: draft.segments.map((s) => (s.id === seg.id ? { ...s, startMs: clamped } : s)),
      });
    } else {
      const next = idx < draft.segments.length - 1 ? draft.segments[idx + 1] : null;
      const lower = seg.startMs + 1;
      const upper = next ? next.startMs : Number.MAX_SAFE_INTEGER;
      const clamped = Math.min(Math.max(atMs, lower), upper);
      onChange({
        ...draft,
        segments: draft.segments.map((s) => (s.id === seg.id ? { ...s, endMs: clamped } : s)),
      });
    }
  }

  const countFor = (index: number) => draft.segments.filter((s) => s.speakerIndex === index).length;
  const displayLabel = (sp: Speaker) =>
    sp.label?.trim() ? sp.label : defaultSpeakerLabel(sp.index);

  return (
    <div className="script-editor">
      {/* Speakers: rename inline, add, remove */}
      <div className="spk-list">
        {draft.speakers.map((sp) => (
          <div className="spk-row" key={sp.index}>
            <span className="spk-dot" style={{ background: colorFor(sp.index) }} aria-hidden />
            <input
              // The field starts EMPTY for an auto/default label (the default shows as a greyed
              // placeholder instead) and only carries text for a genuinely-renamed speaker. This
              // sidesteps a UXP bug: when a *pristine* field that holds programmatic text gains focus,
              // UXP selects the whole value with the caret anchored at 0, and its selection API is
              // decoupled from the real caret (setSelectionRange reports a new position but the visible
              // caret stays at the front) — so it can't be corrected by JS. An empty field has nothing
              // to select, so the caret behaves and the user just types the name. It stays
              // uncontrolled (defaultValue, no `value`) so React never re-applies the value to the DOM
              // — the field owns its text and keeps the caret. onChange still fires per keystroke so
              // the name updates live in the line tags; blur only normalises an emptied field back to
              // the default.
              className="spk-name"
              type="text"
              defaultValue={isAutoSpeakerLabel(sp.label) ? "" : sp.label}
              placeholder={defaultSpeakerLabel(sp.index)}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onChange={(e) => renameSpeaker(sp.index, e.currentTarget.value)}
              onBlur={(e) => {
                if (e.currentTarget.value.trim() === "") renameSpeaker(sp.index, defaultSpeakerLabel(sp.index));
              }}
            />
            <span className="spk-count">{countFor(sp.index)} clips</span>
            <div
              className={`spk-del${canRemove ? "" : " spk-del--off"}`}
              role="button"
              tabIndex={canRemove ? 0 : -1}
              aria-label={`Remove ${sp.label}`}
              title={canRemove ? "Remove speaker" : "At least one speaker is required"}
              onClick={canRemove ? () => removeSpeaker(sp.index) : undefined}
            >
              ×
            </div>
          </div>
        ))}
      </div>
      <div className="spk-add" role="button" tabIndex={0} onClick={addSpeaker}>
        + Add speaker
      </div>


      {/* Lines: edit text directly; Enter mid-line splits, Backspace at the start merges up; tap the
          time to fine-tune the split, tap the colored tag to reassign the speaker. */}
      <p className="seg-hint">
        Tap a line to edit · Enter mid-line to split · ⌫ at the start to merge up · tap the time to fine-tune
      </p>
      <ul className="seg-list">
        {draft.segments.map((seg) => (
          <li className="seg-row" key={seg.id}>
            <span className="seg-time">
              {editTimeId === seg.id && editTimeKind === "start" ? (
                <input
                  className="seg-time-input"
                  type="text"
                  value={timeInput}
                  placeholder="mm:ss"
                  autoFocus
                  onChange={(e) => setTimeInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTime(seg);
                    else if (e.key === "Escape") setEditTimeId(null);
                  }}
                  onBlur={() => commitTime(seg)}
                />
              ) : (
                <span
                  className="seg-time-part"
                  role="button"
                  tabIndex={0}
                  title="Tap to adjust the start time"
                  onClick={() => openTime(seg, "start")}
                >
                  {formatMs(seg.startMs)}
                </span>
              )}
              <span className="seg-time-sep"> – </span>
              {editTimeId === seg.id && editTimeKind === "end" ? (
                <input
                  className="seg-time-input"
                  type="text"
                  value={timeInput}
                  placeholder="mm:ss"
                  autoFocus
                  onChange={(e) => setTimeInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTime(seg);
                    else if (e.key === "Escape") setEditTimeId(null);
                  }}
                  onBlur={() => commitTime(seg)}
                />
              ) : (
                <span
                  className="seg-time-part"
                  role="button"
                  tabIndex={0}
                  title="Tap to adjust the end time"
                  onClick={() => openTime(seg, "end")}
                >
                  {formatMs(seg.endMs)}
                </span>
              )}
            </span>
            <div className="seg-main">
              <div
                className="seg-tag"
                role="button"
                tabIndex={0}
                style={{ background: colorFor(seg.speakerIndex), flex: `0 0 ${tagWidth}px`, width: tagWidth }}
                aria-haspopup="listbox"
                aria-expanded={pickerSegId === seg.id}
                title="Tap to choose speaker"
                onClick={() => setPickerSegId((cur) => (cur === seg.id ? null : seg.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPickerSegId((cur) => (cur === seg.id ? null : seg.id));
                  }
                }}
              >
                {displayLabel(draft.speakers.find((sp) => sp.index === seg.speakerIndex) ?? { index: seg.speakerIndex, label: "" })}
              </div>
              <input
                className="seg-text-input"
                type="text"
                ref={(el) => {
                  if (el) inputRefs.current[seg.id] = el;
                  else delete inputRefs.current[seg.id];
                }}
                value={seg.text}
                placeholder="Empty line — type a caption"
                onFocus={(e) => {
                  // UXP selects a field's *whole value* when it gains focus while still holding
                  // its original (programmatic) text — so a single keystroke would wipe the line.
                  // The field can't be emptied like the speaker-name input (it has to show the
                  // caption), so instead collapse the selection to the end on the next tick, after
                  // UXP's own select-all has settled. Focusing a line then just places the caret.
                  const el = e.currentTarget;
                  const end = el.value.length;
                  setTimeout(() => {
                    try {
                      el.setSelectionRange(end, end);
                    } catch {
                      /* selection API may be unavailable; at worst the select-all stands */
                    }
                  }, 0);
                }}
                onChange={(e) => {
                  setSegmentText(seg, e.currentTarget.value);
                }}
                onKeyDown={(e) => {
                  onTextKeyDown(e, seg);
                }}
              />
            </div>
            {pickerSegId === seg.id && (
              <div className="seg-spk-menu" role="listbox" aria-label="Choose speaker">
                {draft.speakers.map((sp) => (
                  <div
                    key={sp.index}
                    className="seg-spk-option"
                    role="option"
                    aria-selected={sp.index === seg.speakerIndex}
                    tabIndex={0}
                    onClick={() => assignSpeaker(seg, sp.index)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        assignSpeaker(seg, sp.index);
                      }
                    }}
                  >
                    <span className="seg-spk-dot" style={{ background: colorFor(sp.index) }} aria-hidden />
                    <span className="seg-spk-label">{sp.label || defaultSpeakerLabel(sp.index)}</span>
                    {sp.index === seg.speakerIndex && <span className="seg-spk-check" aria-hidden>✓</span>}
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="script-editor-actions">
        <div
          className={`mix-btn mix-btn--accent${busy ? " mix-btn--disabled" : ""}`}
          role="button"
          tabIndex={busy ? -1 : 0}
          onClick={busy ? undefined : onRegenerate}
        >
          {busy ? "Regenerating…" : "Regenerate audio"}
        </div>
      </div>
    </div>
  );
}
