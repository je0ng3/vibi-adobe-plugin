import { useEffect, useMemo, useRef, useState } from "react";
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
  // `scrub` is the live drag position (0..1) while the user is dragging the bar; it overrides the
  // `progress` prop so the playhead tracks the mouse smoothly without waiting on the player. The
  // svg ref lets the document-level drag handlers map clientX → ratio even when the pointer has
  // left the element.
  const [scrub, setScrub] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const gain = Math.min(1.5, volume / 100);

  // Bars don't depend on playback position, so memoize them: during a drag only the thin progress
  // overlay re-renders each frame, not all ~200 bar rects (keeps scrubbing smooth in UXP).
  const bars = useMemo(() => {
    if (!peaks || peaks.length === 0) return null;
    const barCount = peaks.length;
    const barSlot = VIEW_WIDTH / barCount;
    const barWidth = Math.max(1, barSlot * 0.55);
    return Array.from(peaks).map((p, i) => {
      const h = Math.max(1, Math.min(1, p * gain) * VIEW_HEIGHT);
      const y = (VIEW_HEIGHT - h) / 2;
      const x = i * barSlot + (barSlot - barWidth) / 2;
      return <rect key={i} className="waveform-bar" x={x} y={y} width={barWidth} height={h} rx={0.5} />;
    });
  }, [peaks, gain]);

  function ratioFromClientX(clientX: number): number {
    const el = svgRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  // While dragging, follow the mouse across the whole document (not just over the svg) so the
  // scrub doesn't stick if the pointer slips above/below the bar.
  useEffect(() => {
    if (scrub == null || !onSeek) return;
    const onMove = (ev: globalThis.MouseEvent) => {
      const r = ratioFromClientX(ev.clientX);
      setScrub(r);
      onSeek(r);
    };
    const onUp = (ev: globalThis.MouseEvent) => {
      const r = ratioFromClientX(ev.clientX);
      onSeek(r);
      setScrub(null);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrub != null, onSeek]);

  if (!bars) {
    return <div className="waveform waveform--empty" aria-hidden />;
  }

  function startDrag(e: MouseEvent<SVGSVGElement>) {
    if (!onSeek) return;
    const r = ratioFromClientX(e.clientX);
    setScrub(r);
    onSeek(r);
  }

  const shownRatio = scrub != null ? scrub : progress != null ? Math.min(1, Math.max(0, progress)) : null;
  const progressX = shownRatio != null ? shownRatio * VIEW_WIDTH : null;

  return (
    <svg
      ref={svgRef}
      className={`waveform${selected ? " waveform--selected" : ""}${onSeek ? " waveform--seekable" : ""}`}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      preserveAspectRatio="none"
      onMouseDown={onSeek ? startDrag : undefined}
      aria-hidden
    >
      {progressX != null && (
        <rect className="waveform-progress-fill" x={0} y={0} width={progressX} height={VIEW_HEIGHT} />
      )}
      {bars}
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
