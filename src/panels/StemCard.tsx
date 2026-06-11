import { useEffect, useState } from "react";
import { Waveform } from "./Waveform";
import type { StemView } from "./StemListView";
import { play, stop, setVolume, seek, getCurrentTime, playingId, playbackSupported } from "../audio/player";
import { previewInDefaultApp } from "../audio/preview";

interface Props {
  stem: StemView;
  audioUrl: string | null;
  isActive: boolean;
  onRequestActive: (active: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onToggleSelected: (selected: boolean) => void;
}

const canPlay = playbackSupported();

export function StemCard({
  stem,
  audioUrl,
  isActive,
  onRequestActive,
  onVolumeChange,
  onToggleSelected,
}: Props) {
  const [currentTime, setCurrentTime] = useState(0);

  // Drive playback off isActive (FileCard guarantees only one card is active at a time).
  useEffect(() => {
    if (!isActive || !audioUrl) return;
    let raf = 0;
    void play(stem.id, audioUrl, {
      volume: stem.volume,
      durationSec: stem.durationSec,
      onEnded: () => {
        onRequestActive(false);
        setCurrentTime(0);
      },
    });
    const tick = () => {
      if (playingId() === stem.id) setCurrentTime(getCurrentTime());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (playingId() === stem.id) stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Live volume while this stem is the one playing.
  useEffect(() => {
    if (isActive && playingId() === stem.id) setVolume(stem.volume);
  }, [stem.volume, isActive, stem.id]);

  function seekRatio(ratio: number) {
    if (!stem.durationSec) return;
    if (isActive && playingId() === stem.id) seek(ratio);
    setCurrentTime(ratio * stem.durationSec);
  }

  const progress = stem.durationSec > 0 ? currentTime / stem.durationSec : 0;

  // In a browser (Web Audio present) toggle in-panel playback; in UXP (no audio output) open the
  // clip in the OS default player. <div role="button"> not <button> — UXP buttons render as gray pills.
  function preview() {
    if (!audioUrl) return;
    if (canPlay) {
      onRequestActive(!isActive);
      return;
    }
    previewInDefaultApp(audioUrl, `${stem.label}.wav`).catch((e) => console.warn("[preview]", e));
  }

  return (
    <li className={`stem-card${stem.selected ? " stem-card--selected" : ""}`}>
      <div className="stem-card-top">
        {audioUrl && (
          <div
            className="stem-play"
            role="button"
            tabIndex={0}
            aria-label={canPlay && isActive ? `Pause ${stem.label}` : `Preview ${stem.label}`}
            onClick={preview}
          >
            {canPlay && isActive ? "❚❚" : "▶"}
          </div>
        )}
        <span className="stem-card-label">{stem.label}</span>
        <div className="stem-card-wave">
          <Waveform
            peaks={stem.peaks}
            selected={stem.selected}
            volume={stem.volume}
            progress={progress}
            onSeek={seekRatio}
          />
        </div>
        {canPlay && isActive && stem.durationSec > 0 && (
          <span className="preview-time">
            {fmtClock(currentTime)} / {fmtClock(stem.durationSec)}
          </span>
        )}
        <label className="stem-card-check">
          <input
            type="checkbox"
            checked={stem.selected}
            onChange={(e) => onToggleSelected(e.currentTarget.checked)}
            aria-label={`Select ${stem.label}`}
          />
        </label>
      </div>

      <div className="stem-card-fader">
        <input
          type="range"
          min={0}
          max={150}
          value={stem.volume}
          onChange={(e) => onVolumeChange(Number(e.currentTarget.value))}
          aria-label={`${stem.label} volume`}
        />
        <span className="stem-card-db">{formatDb(stem.volume)}</span>
      </div>
    </li>
  );
}

// "M:SS" elapsed/total readout shown while previewing.
function fmtClock(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDb(volume: number): string {
  if (volume <= 0) return "−∞ dB";
  const db = 20 * Math.log10(volume / 100);
  const sign = db > 0 ? "+" : "";
  return `${sign}${db.toFixed(1)} dB`;
}
