import type { Speaker } from "../types/job";

interface Props {
  speakers: Speaker[];
  onChangeLabel: (index: number, label: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}

export function SpeakerMap({ speakers, onChangeLabel, onAdd, onRemove }: Props) {
  const canRemove = speakers.length > 1;
  return (
    <div className="speaker-map">
      <div className="speaker-map-header">
        <p className="speaker-map-title">Speakers</p>
        {/* <div role="button">, not <button> — UXP paints native buttons as gray pills. */}
        <div className="speaker-map-add" role="button" tabIndex={0} onClick={onAdd}>
          + Add
        </div>
      </div>
      <ul className="speaker-map-list">
        {speakers.map((sp) => (
          <li key={sp.index} className="speaker-map-row">
            <span className="speaker-map-default">Speaker {sp.index}</span>
            <span className="speaker-map-arrow">→</span>
            <input
              className="speaker-map-input"
              type="text"
              value={sp.label}
              onChange={(e) => onChangeLabel(sp.index, e.currentTarget.value)}
              placeholder={`Speaker ${sp.index}`}
            />
            <div
              className={`speaker-map-remove${canRemove ? "" : " speaker-map-remove--disabled"}`}
              role="button"
              tabIndex={canRemove ? 0 : -1}
              aria-label={`Remove speaker ${sp.index}`}
              onClick={canRemove ? () => onRemove(sp.index) : undefined}
              title={canRemove ? "Remove speaker" : "At least one speaker is required"}
            >
              ×
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
