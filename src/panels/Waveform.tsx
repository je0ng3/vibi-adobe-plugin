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

export function Waveform({ peaks, selected, volume = 100, progress, onSeek, selection }: Props) {
  // `scrub` is the live drag position (0..1) while the user is dragging the bar; it overrides the
  // `progress` prop so the playhead tracks the mouse smoothly without waiting on the player. The
  // container ref lets the document-level drag handlers map clientX → ratio even when the pointer
  // has left the element.
  const [scrub, setScrub] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const gain = Math.min(1.5, volume / 100);

  // Bars don't depend on playback position, so memoize them: during a drag only the thin progress
  // overlay re-renders each frame, not all the bar divs (keeps scrubbing smooth in UXP).
  //
  // Rendered as HTML <div>s rather than SVG: the panel stretches the waveform to full width but
  // only ~30px tall, and an SVG with preserveAspectRatio="none" squashes that non-uniformly —
  // flattening round line-caps into rectangles and dropping zero-height (silent) bars entirely.
  // Plain divs have no such distortion, so border-radius gives true pill caps at any size.
  const bars = useMemo(() => {
    if (!peaks || peaks.length === 0) return null;
    // Downsample to a dense set of slim bars (a music-player level meter). Each bar is the peak
    // (max) of its bin so loud transients still read.
    const TARGET_BARS = 64;
    const barCount = Math.min(TARGET_BARS, peaks.length);
    const binSize = peaks.length / barCount;
    // Floor every bar to a small fraction of the height so quiet/silent bins still show as little
    // pills (with a large border-radius they round into dots) rather than leaving gaps.
    const MIN_FRACTION = 0.16;
    return Array.from({ length: barCount }, (_, i) => {
      const start = Math.floor(i * binSize);
      const end = Math.max(start + 1, Math.floor((i + 1) * binSize));
      let mx = 0;
      for (let j = start; j < end && j < peaks.length; j++) mx = Math.max(mx, peaks[j]);
      const amp = Math.min(1, mx * gain);
      const heightPct = (MIN_FRACTION + (1 - MIN_FRACTION) * amp) * 100;
      return <div key={i} className="waveform-bar" style={{ height: `${heightPct}%` }} />;
    });
  }, [peaks, gain]);

  function ratioFromClientX(clientX: number): number {
    const el = rootRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  // While dragging, follow the mouse across the whole document (not just over the bar) so the
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

  function startDrag(e: MouseEvent<HTMLDivElement>) {
    if (!onSeek) return;
    const r = ratioFromClientX(e.clientX);
    setScrub(r);
    onSeek(r);
  }

  const shownRatio = scrub != null ? scrub : progress != null ? Math.min(1, Math.max(0, progress)) : null;
  const progressPct = shownRatio != null ? shownRatio * 100 : null;

  return (
    <div
      ref={rootRef}
      className={`waveform${selected ? " waveform--selected" : ""}${onSeek ? " waveform--seekable" : ""}`}
      onMouseDown={onSeek ? startDrag : undefined}
      aria-hidden
    >
      {progressPct != null && (
        <div className="waveform-progress-fill" style={{ width: `${progressPct}%` }} />
      )}
      <div className="waveform-bars">{bars}</div>
      {progressPct != null && (
        <div className="waveform-progress-line" style={{ left: `${progressPct}%` }} />
      )}
      {selection && (
        <div
          className="waveform-selection"
          style={{
            left: `${selection.startRatio * 100}%`,
            width: `${Math.max(0, selection.endRatio - selection.startRatio) * 100}%`,
          }}
        />
      )}
    </div>
  );
}
