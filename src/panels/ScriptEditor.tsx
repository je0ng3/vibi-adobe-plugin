import { useState } from "react";
import type { ScriptDraft, TranscriptSegment } from "../types/job";

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
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// Parse a user-typed split point into ms. Accepts "mm:ss", "mm:ss.s", or bare seconds ("9.5").
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
// collapsed/expanded without losing edits. Rename / add / remove speakers and reassign each line's
// speaker by tapping its colored tag (no <select>/<textarea> — UXP doesn't render those reliably).
export function ScriptEditor({ draft, busy, onChange, onRegenerate }: Props) {
  const canRemove = draft.speakers.length > 1;
  // Which line is being split, and the typed split point. Local UI state — the split itself just
  // edits the draft (two segments in place of one), so nothing here needs to leave the component.
  const [splitId, setSplitId] = useState<string | null>(null);
  const [splitInput, setSplitInput] = useState("");

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

  // Tap a line's speaker tag → assign the next speaker (wraps). Direct, no hidden dropdown.
  function cycleSegmentSpeaker(seg: TranscriptSegment) {
    const order = draft.speakers.map((sp) => sp.index);
    const next = order[(order.indexOf(seg.speakerIndex) + 1) % order.length];
    onChange({ ...draft, segments: draft.segments.map((s) => (s.id === seg.id ? { ...s, speakerIndex: next } : s)) });
  }

  // Open the inline split editor on a line, prefilled with its midpoint as a sensible default.
  function openSplit(seg: TranscriptSegment) {
    setSplitInput(formatMs(Math.round((seg.startMs + seg.endMs) / 2)));
    setSplitId(seg.id);
  }

  // Split one line at `atMs` into two: the first keeps the text, the second starts empty and stays
  // on the same speaker until the user taps its tag to reassign. Order is preserved in the list.
  function splitSegment(seg: TranscriptSegment, atMs: number) {
    if (atMs <= seg.startMs || atMs >= seg.endMs) return;
    const first: TranscriptSegment = { ...seg, endMs: atMs };
    const second: TranscriptSegment = { ...seg, id: `${seg.id}-s${atMs}`, startMs: atMs, text: "" };
    onChange({ ...draft, segments: draft.segments.flatMap((s) => (s.id === seg.id ? [first, second] : [s])) });
    setSplitId(null);
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

      {/* Lines: tap the colored tag to reassign the speaker; tap ✂ to split the line in two */}
      <p className="seg-hint">Tap a name tag to reassign a line. Tap ✂ to split a line at a time, then reassign each half.</p>
      <ul className="seg-list">
        {draft.segments.map((seg) => {
          const atMs = splitId === seg.id ? parseTimeToMs(splitInput) : null;
          const splitValid = atMs !== null && atMs > seg.startMs && atMs < seg.endMs;
          return (
            <li className="seg-row" key={seg.id}>
              <div
                className="seg-tag"
                role="button"
                tabIndex={0}
                style={{ background: colorFor(seg.speakerIndex) }}
                title="Tap to reassign"
                onClick={() => cycleSegmentSpeaker(seg)}
              >
                {labelFor(seg.speakerIndex)}
              </div>
              <div className="seg-body">
                <span className="seg-time">{formatMs(seg.startMs)}</span>
                {seg.text ? <span className="seg-text">{seg.text}</span> : null}
                {splitId === seg.id ? (
                  <div className="seg-split">
                    <input
                      className="seg-split-input"
                      type="text"
                      value={splitInput}
                      placeholder="mm:ss"
                      onChange={(e) => setSplitInput(e.currentTarget.value)}
                    />
                    <div
                      className={`seg-split-go${splitValid ? "" : " seg-split-go--off"}`}
                      role="button"
                      tabIndex={splitValid ? 0 : -1}
                      title={splitValid ? "Split here" : "Pick a time inside this line"}
                      onClick={splitValid ? () => splitSegment(seg, atMs as number) : undefined}
                    >
                      Split
                    </div>
                    <div className="seg-split-cancel" role="button" tabIndex={0} onClick={() => setSplitId(null)}>
                      Cancel
                    </div>
                  </div>
                ) : null}
              </div>
              <div
                className="seg-split-toggle"
                role="button"
                tabIndex={0}
                aria-label="Split this line"
                title="Split this line"
                onClick={() => (splitId === seg.id ? setSplitId(null) : openSplit(seg))}
              >
                ✂
              </div>
            </li>
          );
        })}
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
