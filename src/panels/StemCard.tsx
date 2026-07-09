import { useEffect, useRef, useState } from "react";
import { Waveform } from "./Waveform";
import type { StemView } from "./StemListView";
import { play, stop, pause, resume, setVolume, seek, getCurrentTime, playingId, playbackSupported } from "../audio/player";
import { previewInDefaultApp } from "../audio/preview";
import { formatClock } from "../audio/format";

interface Props {
  stem: StemView;
  // Short label shown in the card (e.g. "1", "No reaction"); the full name lives in `stem.label`
  // and surfaces via the hover tooltip. Playback/aria/filenames keep using the full `stem.label`.
  displayLabel: string;
  // Shared label-column width (px) so every card's name lines up (centered within it).
  labelWidth: number;
  // Globally-unique per card (entry.id). The playback backend is a single global singleton keyed by
  // the play id, but stem ids ("vocals"/"background"/…) repeat across cards — so the id we hand the
  // backend must be namespaced by the card, or one file's stem plays/steals another's.
  cardKey: string;
  audioUrl: string | null;
  isActive: boolean;
  onRequestActive: (active: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onToggleSelected: (selected: boolean) => void;
}

const canPlay = playbackSupported();

export function StemCard({
  stem,
  displayLabel,
  labelWidth,
  cardKey,
  audioUrl,
  isActive,
  onRequestActive,
  onVolumeChange,
  onToggleSelected,
}: Props) {
  const [currentTime, setCurrentTime] = useState(0);
  const [paused, setPaused] = useState(false);
  // True iff this card was ALREADY active at mount — leftover playback intent from a remount (card
  // collapsed→expanded, project closed→reopened), not a fresh user click. Auto-starting then is the
  // "previously-played stem replays on reopen" bug, so we clear the stale flag instead of playing.
  // A genuine click mounts the card inactive, so this stays false for real playback.
  const staleActiveOnMount = useRef(isActive);
  // The id the shared backend knows this clip by — unique across every card+stem.
  const playKey = `${cardKey}:${stem.id}`;
  // Whether this card has actually owned the shared backend at least once this activation. Lets the
  // tick distinguish "not playing yet (still loading)" from "another card took the backend from us".
  const ownedRef = useRef(false);

  // Drive playback off isActive. Only one stem per card is active; across cards the single shared
  // backend can play only one clip, so if another card starts, the tick below deactivates us.
  useEffect(() => {
    if (!isActive) return;
    if (staleActiveOnMount.current) {
      staleActiveOnMount.current = false;
      onRequestActive(false); // drop the leftover active state instead of auto-replaying
      return;
    }
    if (!audioUrl) return;
    let raf = 0;
    setPaused(false);
    ownedRef.current = false;
    // UXP audio is fragile (hidden-<video> path can throw MediaError); if play rejects, drop back
    // out of the active state so the button doesn't stay stuck showing "playing" with no sound.
    play(playKey, audioUrl, {
      volume: stem.volume,
      durationSec: stem.durationSec,
      onEnded: () => {
        onRequestActive(false);
        setCurrentTime(0);
        setPaused(false);
      },
    }).catch((e) => {
      console.warn("[play] stem playback failed:", e);
      onRequestActive(false);
    });
    const tick = () => {
      const pid = playingId();
      if (pid === playKey) {
        ownedRef.current = true;
        setCurrentTime(getCurrentTime());
      } else if (ownedRef.current) {
        // We owned the backend but another clip (another card/stem) took it over. Drop out of active
        // so this card's play button + progress bar stop lying about playing.
        onRequestActive(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (playingId() === playKey) stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  // Live volume while this stem is the one playing.
  useEffect(() => {
    if (isActive && playingId() === playKey) setVolume(stem.volume);
  }, [stem.volume, isActive, playKey]);

  function seekRatio(ratio: number) {
    if (!stem.durationSec) return;
    if (isActive && playingId() === playKey) seek(ratio);
    setCurrentTime(ratio * stem.durationSec);
  }

  const progress = stem.durationSec > 0 ? currentTime / stem.durationSec : 0;
  const [volumeOpen, setVolumeOpen] = useState(false);

  // UXP can't render a vertical <input type="range"> (it ignores both transform:rotate and
  // appearance:slider-vertical), so the volume control is a plain-div slider: a track, a fill, and a
  // thumb, dragged via document mouse events (the same pattern Waveform uses). Volume runs 0–200 with
  // the bottom of the track = 0 and the top = 200.
  const VOL_MAX = 200;
  const volTrackRef = useRef<HTMLDivElement | null>(null);
  function volFromClientY(clientY: number): number {
    const el = volTrackRef.current;
    if (!el) return stem.volume;
    const rect = el.getBoundingClientRect();
    const ratio = 1 - (clientY - rect.top) / rect.height; // top → 1, bottom → 0
    return Math.round(Math.max(0, Math.min(1, ratio)) * VOL_MAX);
  }
  function onVolPointerDown(e: React.MouseEvent) {
    e.preventDefault();
    onVolumeChange(volFromClientY(e.clientY));
    const move = (ev: MouseEvent) => onVolumeChange(volFromClientY(ev.clientY));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // In a browser (Web Audio present) toggle in-panel playback; in UXP (no audio output) open the
  // clip in the OS default player. <div role="button"> not <button> — UXP buttons render as gray pills.
  function preview() {
    if (!audioUrl) return;
    if (!canPlay) {
      previewInDefaultApp(audioUrl, `${stem.label}.wav`).catch((e) => console.warn("[preview]", e));
      return;
    }
    if (!isActive) {
      onRequestActive(true); // 처음부터 재생
    } else if (paused) {
      resume(); // 멈춘 위치에서 이어서
      setPaused(false);
    } else {
      pause(); // 위치 보존하며 일시정지
      setPaused(true);
    }
  }

  // Clicking anywhere on the card toggles whether the stem is in the mix; the play button,
  // waveform, and volume control stop propagation so their own interactions don't also toggle.
  function toggleSelected() {
    onToggleSelected(!stem.selected);
  }

  return (
    <li
      className={`stem-card${stem.selected ? " stem-card--selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={stem.selected}
      aria-label={`${stem.label}${stem.selected ? " (in mix)" : ""}`}
      onClick={toggleSelected}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleSelected();
        }
      }}
    >
      <div className="stem-card-content">
        <div className="stem-card-header">
          <span className="stem-card-label" style={{ width: labelWidth }} title={stem.label}>
            {displayLabel}
          </span>
          {/* Seeking is its own interaction — don't let a waveform click also toggle selection. */}
          <div className="stem-card-wave" onClick={(e) => e.stopPropagation()}>
            <Waveform
              peaks={stem.peaks}
              selected={stem.selected}
              volume={stem.volume}
              progress={progress}
              onSeek={seekRatio}
            />
          </div>
        </div>

        <div className="stem-card-footer">
          {/* Transport — play + time grouped as one unit on the left. */}
          <div className="stem-card-transport">
            {audioUrl && (
              <div
                className={`stem-play${canPlay && isActive && !paused ? " stem-play--active" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={canPlay && isActive && !paused ? `Pause ${stem.label}` : `Play ${stem.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  preview();
                }}
              >
                {canPlay && isActive && !paused ? "❚❚" : "▶"}
              </div>
            )}
            <span className="preview-time">
              {formatClock(isActive ? currentTime : 0)} / {" "}
              {formatClock(stem.durationSec)}
            </span>
          </div>

          <div className="stem-card-actions">
            {/* Volume is its own control — clicks here adjust volume, they don't toggle selection. */}
            <div className="volume-control" onClick={(e) => e.stopPropagation()}>
                <div
                  className="volume-button"
                  role="button"
                  onClick={() => setVolumeOpen(!volumeOpen)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setVolumeOpen(v => !v);
                    }
                  }}
                >
                  ♫
                </div>
                {volumeOpen && (
                  <div className="volume-popup">
                    <div
                      className="volume-slider"
                      ref={volTrackRef}
                      role="slider"
                      tabIndex={0}
                      aria-label={`${stem.label} volume`}
                      aria-valuemin={0}
                      aria-valuemax={VOL_MAX}
                      aria-valuenow={stem.volume}
                      onMouseDown={onVolPointerDown}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowUp" || e.key === "ArrowRight") {
                          e.preventDefault();
                          onVolumeChange(Math.min(VOL_MAX, stem.volume + 5));
                        } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
                          e.preventDefault();
                          onVolumeChange(Math.max(0, stem.volume - 5));
                        }
                      }}
                    >
                      <div
                        className="volume-slider-fill"
                        style={{ height: `${(stem.volume / VOL_MAX) * 100}%` }}
                      />
                      <div
                        className="volume-slider-thumb"
                        style={{ bottom: `${(stem.volume / VOL_MAX) * 100}%` }}
                      />
                    </div>
                    <span className="volume-readout">
                      <span>{formatDb(stem.volume)}</span>
                      <span>dB</span>
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
    </li>
  );
}

// Numeric part only ("−∞", "+6.0", "−3.5"); the "dB" unit is rendered on its own line in the markup.
function formatDb(volume: number): string {
  if (volume <= 0) return "−∞";
  const db = 20 * Math.log10(volume / 100);
  const sign = db > 0 ? "+" : "";
  return `${sign}${db.toFixed(1)}`;
}
