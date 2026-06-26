import { useEffect, useRef, useState } from "react";
import type { ScriptDraft, TranscriptSegment } from "../types/job";
import { formatClock } from "../audio/format";

interface Props {
  draft: ScriptDraft;
  busy: boolean;
  onChange: (draft: ScriptDraft) => void;
  onRegenerate: () => void;
}

// Per-speaker colors — primary/success from the design system plus an amber to keep three hues
// distinct (danger red is avoided to dodge its error semantics). A speaker reads the same color in
// the list and in every line tag; past the third speaker the palette wraps.
const SPEAKER_COLORS = ["#644AFF", "#0BC673", "#F0A93D"];
const colorFor = (index: number) => SPEAKER_COLORS[Math.abs(index) % SPEAKER_COLORS.length];

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
  // Which line's start time is being edited, and the typed value. Local UI state.
  const [editTimeId, setEditTimeId] = useState<string | null>(null);
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
  }, [pendingFocus]);

  function renameSpeaker(index: number, label: string) {
    onChange({ ...draft, speakers: draft.speakers.map((sp) => (sp.index === index ? { ...sp, label } : sp)) });
  }

  function addSpeaker() {
    const nextIndex = draft.speakers.reduce((m, sp) => Math.max(m, sp.index), 0) + 1;
    onChange({ ...draft, speakers: [...draft.speakers, { index: nextIndex, label: `화자 ${nextIndex}` }] });
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

  function openTime(seg: TranscriptSegment) {
    setTimeInput(formatMs(seg.startMs));
    setEditTimeId(seg.id);
  }

  // Commit an edited start time. The start of a line is the boundary it shares with the line above,
  // so moving it drags the previous line's end with it (clamped inside both lines).
  function commitTime(seg: TranscriptSegment) {
    const atMs = parseTimeToMs(timeInput);
    setEditTimeId(null);
    if (atMs === null) return;
    const idx = draft.segments.findIndex((s) => s.id === seg.id);
    const prev = idx > 0 ? draft.segments[idx - 1] : null;
    const lower = prev ? prev.startMs + 1 : 0;
    const upper = seg.endMs - 1;
    const clamped = Math.min(Math.max(atMs, lower), upper);
    onChange({
      ...draft,
      segments: draft.segments.map((s) => {
        if (s.id === seg.id) return { ...s, startMs: clamped };
        if (prev && s.id === prev.id) return { ...s, endMs: clamped };
        return s;
      }),
    });
  }

  const labelFor = (index: number) => draft.speakers.find((sp) => sp.index === index)?.label || `화자 ${index}`;
  const countFor = (index: number) => draft.segments.filter((s) => s.speakerIndex === index).length;

  return (
    <div className="script-editor">
      {/* Speakers: rename inline, add, remove */}
      <div className="spk-list">
        {draft.speakers.map((sp) => (
          <div className="spk-row" key={sp.index}>
            <span className="spk-dot" style={{ background: colorFor(sp.index) }} aria-hidden />
            <input
              className="spk-name"
              type="text"
              value={sp.label}
              placeholder={`화자 ${sp.index}`}
              onChange={(e) => renameSpeaker(sp.index, e.currentTarget.value)}
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
            {editTimeId === seg.id ? (
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
                className="seg-time"
                role="button"
                tabIndex={0}
                title="Tap to adjust the start time"
                onClick={() => openTime(seg)}
              >
                {formatMs(seg.startMs)}
              </span>
            )}
            <div className="seg-main">
              <div
                className="seg-tag"
                role="button"
                tabIndex={0}
                style={{ background: colorFor(seg.speakerIndex) }}
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
                {labelFor(seg.speakerIndex)}
              </div>
              <input
                className="seg-text-input"
                type="text"
                ref={(el) => {
                  inputRefs.current[seg.id] = el;
                }}
                value={seg.text}
                placeholder="Empty line — type a caption"
                onChange={(e) => setSegmentText(seg, e.currentTarget.value)}
                onKeyDown={(e) => onTextKeyDown(e, seg)}
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
                    <span className="seg-spk-label">{sp.label || `화자 ${sp.index}`}</span>
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
