import { useEffect, useState } from "react";
import { Waveform } from "./Waveform";
import { play, stop, seek, getCurrentTime, playingId, playbackSupported } from "../audio/player";
import { previewInDefaultApp } from "../audio/preview";

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

// "M:SS" elapsed/total readout shown while previewing.
function fmtClock(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

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
    void play(result.id, audioUrl, {
      durationSec: result.durationSec,
      onEnded: () => {
        onRequestActive(false);
        setCurrentTime(0);
      },
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
  const sizeMb = (result.byteLength / 1024 / 1024).toFixed(1);
  // Edit only the base name — the ".wav" is managed for the user (shown in the meta line and
  // re-appended on every keystroke) so it can't be accidentally deleted and break the import.
  const baseName = result.name.replace(/\.wav$/i, "");

  // Browser: toggle in-panel playback. UXP (no audio output): open the mix in the OS default player.
  function preview() {
    if (!audioUrl) return;
    if (canPlay) {
      onRequestActive(!isActive);
      return;
    }
    previewInDefaultApp(audioUrl, `${baseName || "mix"}.wav`).catch((e) => console.warn("[preview]", e));
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
              value={baseName}
              aria-label="Mix name — click to rename"
              title="Click to rename"
              placeholder="Mix name"
              spellCheck={false}
              onChange={(e) => onRename(`${e.currentTarget.value}.wav`)}
            />
          ) : (
            <p className="mix-output-name">{result.name}</p>
          )}
          <p className="mix-output-meta">WAV · {result.stemCount} stems · {sizeMb} MB</p>
          {canPlay && isActive && result.durationSec > 0 && (
            <p className="preview-time">
              {fmtClock(currentTime)} / {fmtClock(result.durationSec)}
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
