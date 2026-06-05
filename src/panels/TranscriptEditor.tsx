import type { Speaker, TranscriptSegment } from "../types/job";

interface Props {
  speakers: Speaker[];
  segments: TranscriptSegment[];
  onSegmentChange: (id: string, partial: Partial<TranscriptSegment>) => void;
}

export function TranscriptEditor({ speakers, segments, onSegmentChange }: Props) {
  return (
    <ul className="transcript-list">
      {segments.map((seg) => (
        <li key={seg.id} className="transcript-segment">
          <div className="transcript-segment-meta">
            <select
              className="transcript-segment-speaker"
              value={seg.speakerIndex}
              onChange={(e) => onSegmentChange(seg.id, { speakerIndex: Number(e.currentTarget.value) })}
              aria-label="Speaker"
            >
              {speakers.map((sp) => (
                <option key={sp.index} value={sp.index}>
                  {sp.label || `Speaker ${sp.index}`}
                </option>
              ))}
            </select>
            <span className="transcript-segment-time">
              {formatMs(seg.startMs)} – {formatMs(seg.endMs)}
            </span>
          </div>
          <textarea
            className="transcript-segment-text"
            value={seg.text}
            rows={2}
            onChange={(e) => onSegmentChange(seg.id, { text: e.currentTarget.value })}
            aria-label="Segment text"
          />
        </li>
      ))}
    </ul>
  );
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
