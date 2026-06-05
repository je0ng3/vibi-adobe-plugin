import { useRef, useState, type MouseEvent } from "react";
import { Waveform } from "./Waveform";
import type { SelectionRange } from "../types/job";
import { ratioToTime } from "../audio/waveform";

interface Props {
  peaks: Float32Array | null;
  durationSec: number;
  progress: number;
  selection: SelectionRange | null;
  onSelectionChange: (range: SelectionRange | null) => void;
  onSeek: (ratio: number) => void;
}

const DRAG_THRESHOLD_PX = 5;

export function RangeSelector({
  peaks,
  durationSec,
  progress,
  selection,
  onSelectionChange,
  onSeek,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; ratio: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [localSelection, setLocalSelection] = useState<SelectionRange | null>(null);

  function pointToRatio(clientX: number): number {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function onMouseDown(e: MouseEvent<HTMLDivElement>) {
    dragRef.current = { x: e.clientX, ratio: pointToRatio(e.clientX) };
    setDragging(false);
    setLocalSelection(null);
  }

  function onMouseMove(e: MouseEvent<HTMLDivElement>) {
    const start = dragRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    if (!dragging && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    if (!dragging) setDragging(true);
    const cur = pointToRatio(e.clientX);
    setLocalSelection({
      startRatio: Math.min(start.ratio, cur),
      endRatio: Math.max(start.ratio, cur),
    });
  }

  function onMouseUp(e: MouseEvent<HTMLDivElement>) {
    const start = dragRef.current;
    dragRef.current = null;
    if (!start) return;
    if (dragging && localSelection) {
      onSelectionChange(localSelection);
    } else {
      onSeek(pointToRatio(e.clientX));
    }
    setDragging(false);
    setLocalSelection(null);
  }

  function onMouseLeave() {
    dragRef.current = null;
    setDragging(false);
    setLocalSelection(null);
  }

  const shown = localSelection ?? selection;

  return (
    <div className="range-selector">
      <div
        ref={containerRef}
        className="range-selector-surface"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
      >
        <Waveform peaks={peaks} selected progress={progress} selection={shown} />
      </div>
      <div className="range-selector-info">
        {shown ? (
          <>
            <span>
              {ratioToTime(shown.startRatio, durationSec)} – {ratioToTime(shown.endRatio, durationSec)}
            </span>
            <button
              type="button"
              className="range-selector-clear"
              onClick={() => onSelectionChange(null)}
            >
              Clear range
            </button>
          </>
        ) : (
          <span className="range-selector-hint">Drag on waveform to select a range · click to seek</span>
        )}
      </div>
    </div>
  );
}
