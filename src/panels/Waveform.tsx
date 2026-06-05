import type { MouseEvent } from "react";
import type { SelectionRange } from "../types/job";

interface Props {
  peaks: Float32Array | null;
  selected?: boolean;
  volume?: number;
  progress?: number;
  onSeek?: (ratio: number) => void;
  selection?: SelectionRange | null;
}

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 80;

export function Waveform({ peaks, selected, volume = 100, progress, onSeek, selection }: Props) {
  if (!peaks || peaks.length === 0) {
    return <div className="waveform waveform--empty" aria-hidden />;
  }
  const barCount = peaks.length;
  const barSlot = VIEW_WIDTH / barCount;
  const barWidth = Math.max(1, barSlot * 0.55);
  const gain = Math.min(1.5, volume / 100);
  const progressX = progress != null ? Math.min(1, Math.max(0, progress)) * VIEW_WIDTH : null;

  function handleClick(e: MouseEvent<SVGSVGElement>) {
    if (!onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    onSeek(Math.min(1, Math.max(0, ratio)));
  }

  return (
    <svg
      className={`waveform${selected ? " waveform--selected" : ""}${onSeek ? " waveform--seekable" : ""}`}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      onClick={onSeek ? handleClick : undefined}
      aria-hidden
    >
      {progressX != null && (
        <rect
          className="waveform-progress-fill"
          x={0}
          y={0}
          width={progressX}
          height={VIEW_HEIGHT}
        />
      )}
      {Array.from(peaks).map((p, i) => {
        const h = Math.max(1, Math.min(1, p * gain) * VIEW_HEIGHT);
        const y = (VIEW_HEIGHT - h) / 2;
        const x = i * barSlot + (barSlot - barWidth) / 2;
        const played = progressX != null && x + barWidth / 2 <= progressX;
        return (
          <rect
            key={i}
            className={played ? "waveform-bar waveform-bar--played" : "waveform-bar"}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={0.5}
          />
        );
      })}
      {progressX != null && (
        <line
          className="waveform-progress-line"
          x1={progressX}
          x2={progressX}
          y1={0}
          y2={VIEW_HEIGHT}
        />
      )}
      {selection && (
        <rect
          className="waveform-selection"
          x={selection.startRatio * VIEW_WIDTH}
          y={0}
          width={Math.max(0, (selection.endRatio - selection.startRatio) * VIEW_WIDTH)}
          height={VIEW_HEIGHT}
        />
      )}
    </svg>
  );
}
