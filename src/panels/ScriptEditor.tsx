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

// Controlled inline editor: the working draft lives in the parent (FileCard) so the panel can be
// collapsed/expanded without losing edits. Rename / add / remove speakers and reassign each line's
// speaker by tapping its colored tag (no <select>/<textarea> — UXP doesn't render those reliably).
export function ScriptEditor({ draft, busy, onChange, onRegenerate }: Props) {
  const canRemove = draft.speakers.length > 1;

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

      {/* Lines: tap the colored tag to reassign the speaker */}
      <p className="seg-hint">Tap a name tag to reassign that line to another speaker.</p>
      <ul className="seg-list">
        {draft.segments.map((seg) => (
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
              <span className="seg-text">{seg.text}</span>
            </div>
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
