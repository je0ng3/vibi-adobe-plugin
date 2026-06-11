import { useEffect, useState } from "react";
import { listProjectMediaItems, importProjectMediaItem, type ProjectMediaItem } from "../host/premiere";
import type { LoadedAudioSource } from "../input/audioPicker";
import { IconAudio } from "../components/Icons";

interface Props {
  onClose: () => void;
  onImport: (sources: LoadedAudioSource[]) => void;
}

// Inline (NOT a modal popup): the project's media listed right inside the panel, so picking from
// the project feels like the other sources instead of opening a separate window. The Project panel
// exposes no selection API, so we walk the bin tree and let the user click an item to import.
// Rows are <div role="button">, not <button>: UXP's native button paints a rounded gray pill.
export function ProjectBrowser({ onClose, onImport }: Props) {
  const [items, setItems] = useState<ProjectMediaItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  // Progress text while a video item's audio is extracted (Adobe Media Encoder).
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    listProjectMediaItems()
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function pick(item: ProjectMediaItem) {
    setError(null);
    setStatus(null);
    setBusyPath(item.mediaPath);
    try {
      const src = await importProjectMediaItem(item.mediaPath, setStatus);
      onImport([src]);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyPath(null);
      setStatus(null);
    }
  }

  const busy = busyPath != null;

  return (
    <div className="proj-browser">
      <div className="proj-browser-head">
        <span className="proj-browser-title">Project media</span>
        <div className="proj-browser-close" role="button" tabIndex={0} aria-label="Close" onClick={onClose}>
          ×
        </div>
      </div>

      {error && <p className="panel-error">{error}</p>}
      {status && <p className="panel-status">{status}</p>}
      {!items && !error && <p className="proj-browser-info">Loading project items…</p>}
      {items && items.length === 0 && (
        <p className="proj-browser-info">No audio or video media found in this project.</p>
      )}

      {items && items.length > 0 && (
        <ul className="proj-list">
          {items.map((it) => (
            <li key={it.mediaPath}>
              <div
                className={`proj-row${busy ? " proj-row--disabled" : ""}`}
                role="button"
                tabIndex={busy ? -1 : 0}
                onClick={busy ? undefined : () => pick(it)}
              >
                <span className="proj-icon" aria-hidden>
                  <IconAudio size={16} />
                </span>
                <span className="proj-text">
                  <span className="proj-name">{it.name}</span>
                </span>
                <span className="proj-ext">
                  {busyPath === it.mediaPath ? "Adding…" : it.ext.toUpperCase()}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
