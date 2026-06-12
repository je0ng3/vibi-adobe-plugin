import { useEffect, useState } from "react";
import { Waveform } from "./Waveform";
import { play, stop, seek, getCurrentTime, playingId, playbackSupported } from "../audio/player";
import { previewInDefaultApp } from "../audio/preview";
import { formatClock, formatMb } from "../audio/format";

const canPlay = playbackSupported();

export interface MixResult {
  id: string;
  name: string;
  byteLength: number;
  stemCount: number;
  peaks: Float32Array;
  audioUrl: string;
  durationSec: number;
}

type ImportTarget = "project" | "timeline";

interface Props {
  result: MixResult;
  isActive: boolean;
  onRequestActive: (active: boolean) => void;
  onDiscard: () => void;
  onRename?: (name: string) => void;
  importBusy?: ImportTarget | null;
  onImport?: (target: ImportTarget) => void;
}

export function MixOutputView({
  result,
  isActive,
  onRequestActive,
  onDiscard,
  onRename,
  importBusy = null,
  onImport,
}: Props) {
  const audioUrl = result.audioUrl;
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    if (!isActive || !audioUrl) return;
    let raf = 0;
    // UXP audio is fragile; if play rejects, drop out of the active state instead of leaving the
    // button stuck on "playing" with no sound (and no unhandled rejection).
    play(result.id, audioUrl, {
      durationSec: result.durationSec,
      onEnded: () => {
        onRequestActive(false);
        setCurrentTime(0);
      },
    }).catch((e) => {
      console.warn("[play] mix playback failed:", e);
      onRequestActive(false);
    });
    const tick = () => {
      if (playingId() === result.id) setCurrentTime(getCurrentTime());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (playingId() === result.id) stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  function seekRatio(ratio: number) {
    if (!result.durationSec) return;
    if (isActive && playingId() === result.id) seek(ratio);
    setCurrentTime(ratio * result.durationSec);
  }

  const progress = result.durationSec > 0 ? currentTime / result.durationSec : 0;
  const sizeMb = formatMb(result.byteLength);

  // Browser: toggle in-panel playback. UXP (no audio output): open the mix in the OS default player.
  function preview() {
    if (!audioUrl) return;
    if (canPlay) {
      onRequestActive(!isActive);
      return;
    }
    // `result.name` is the base name; the ".wav" is managed here and at import (see FileCard).
    previewInDefaultApp(audioUrl, `${result.name || "mix"}.wav`).catch((e) => console.warn("[preview]", e));
  }

  return (
    <div className="mix-output">
      <div className="mix-output-header">
        {audioUrl && (
          <div
            className="stem-play"
            role="button"
            tabIndex={0}
            aria-label={canPlay && isActive ? "Pause mix" : "Preview mix"}
            onClick={preview}
          >
            {canPlay && isActive ? "❚❚" : "▶"}
          </div>
        )}
        <span className="mix-output-badge">MIX</span>
        <div className="mix-output-info">
          {onRename ? (
            <input
              className="mix-output-name-input"
              value={result.name}
              aria-label="Mix name — click to rename"
              title="Click to rename"
              placeholder="Mix name"
              spellCheck={false}
              onChange={(e) => onRename(e.currentTarget.value)}
            />
          ) : (
            <p className="mix-output-name">{result.name}</p>
          )}
          <p className="mix-output-meta">WAV · {result.stemCount} stems · {sizeMb} MB</p>
          {canPlay && isActive && result.durationSec > 0 && (
            <p className="preview-time">
              {formatClock(currentTime)} / {formatClock(result.durationSec)}
            </p>
          )}
        </div>
        <div
          className="mix-output-close"
          role="button"
          tabIndex={0}
          aria-label="Discard mix"
          onClick={onDiscard}
        >
          ✕
        </div>
      </div>

      <div className="mix-output-wave">
        <Waveform peaks={result.peaks} selected volume={100} progress={progress} onSeek={seekRatio} />
      </div>

      <div className="mix-output-actions">
        {onImport && (
          <>
            <div
              className={`mix-btn${importBusy != null ? " mix-btn--disabled" : ""}`}
              role="button"
              tabIndex={importBusy != null ? -1 : 0}
              onClick={importBusy != null ? undefined : () => onImport("project")}
            >
              {importBusy === "project" ? "Importing…" : "Project"}
            </div>
            <div
              className={`mix-btn${importBusy != null ? " mix-btn--disabled" : ""}`}
              role="button"
              tabIndex={importBusy != null ? -1 : 0}
              onClick={importBusy != null ? undefined : () => onImport("timeline")}
            >
              {importBusy === "timeline" ? "Importing…" : "Timeline"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
