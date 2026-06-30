import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SUPPORTED_EXTS, type LoadedAudioSource } from "../input/audioPicker";
import { readSelectedAudioClips, getActiveProjectKey } from "../host/premiere";
import { listSeparations } from "../jobs/separationClient";
import { ProjectBrowser } from "./ProjectBrowser";
import { FileCard, type FileEntry, type CardView } from "./FileCard";
import { getBalance } from "../jobs/creditClient";
import { BuyCreditsModal } from "./BuyCreditsModal";
import { BrandLockup } from "../brand/Logo";
import { MAX_AUDIO_BYTES, BILLING_ENABLED } from "../config";

interface Props {
  onSignOut: () => void;
}

export function SeparationPanel({ onSignOut }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  // True while the panel rehydrates this project's saved separations on mount.
  const [restoring, setRestoring] = useState(true);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  // Transient progress while a video clip's audio is extracted via Adobe Media Encoder.
  const [pickStatus, setPickStatus] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  // Bumped each time the project button is pressed; used as ProjectBrowser's key so re-pressing
  // (even while it's already open) remounts it and re-fetches, instead of needing a close first.
  const [browseNonce, setBrowseNonce] = useState(0);
  // Master-detail: id of the file whose tab is open, or null = the main list.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function refreshBalance() {
    getBalance()
      .then(setBalance)
      // Keep the last known balance on a transient failure — nulling it would hide the
      // credits badge (and the buy button) on a single flaky request.
      .catch(() => {});
  }

  useEffect(() => {
    refreshBalance();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Rehydrate this project's saved separations so signing out and back in (or reopening the
  // panel — even on another machine) restores the cards. The server is the source of truth: it
  // keeps the separation rows + R2 stems, scoped to the active Premiere project.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const key = await getActiveProjectKey();
        if (cancelled) return;
        setProjectKey(key);
        const saved = await listSeparations(key);
        if (cancelled || saved.length === 0) return;
        // entry id = jobId so a restored card maps 1:1 to its server record.
        const restored: FileEntry[] = saved.map((s) => ({ id: s.jobId, source: null, restored: s }));
        // Restored cards go below anything the user already added in this brief window, and we
        // skip any id that's somehow already present.
        setEntries((prev) => {
          const have = new Set(prev.map((e) => e.id));
          return [...prev, ...restored.filter((e) => !have.has(e.id))];
        });
      } catch (e) {
        console.warn("[history] load failed:", e);
      } finally {
        // Clear the "restoring…" message whether we restored cards, found none, or errored.
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Opening a file's tab clears any stale list-level pick error so it doesn't reappear when you
  // navigate back.
  useEffect(() => {
    if (selectedId != null) setPickError(null);
  }, [selectedId]);

  // 사용자가 vibi 모바일 앱에서 충전하고 돌아온 뒤, 잔액이 자동 반영되도록 몇 분간 폴링한다.
  // 공유 DB 라 앱에서의 충전이 곧 이 잔액(getBalance)에 반영된다.
  function pollBalanceAfterCheckout() {
    if (pollRef.current) clearInterval(pollRef.current);
    const baseline = balance; // balance before the top-up; stop as soon as it rises.
    let ticks = 0;
    const stop = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    pollRef.current = setInterval(async () => {
      ticks++;
      try {
        const b = await getBalance();
        setBalance(b);
        if (baseline != null && b > baseline) stop(); // top-up landed — done early.
      } catch {
        /* keep trying */
      }
      if (ticks >= 40) stop(); // give up after ~2 min.
    }, 3000);
  }

  async function onAddFromPremiere() {
    console.log("[premiere] Add from Premiere clicked");
    setPickError(null);
    setPickerBusy(true);
    try {
      const sources = await readSelectedAudioClips(setPickStatus);
      console.log("[premiere] sources read:", sources.length);
      if (sources.length === 0) {
        setPickError("No audio could be read from the selection.");
        return;
      }
      addEntries(sources);
    } catch (e) {
      console.log("[premiere] error:", e);
      setPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setPickerBusy(false);
      setPickStatus(null);
    }
  }

  function addEntries(sources: LoadedAudioSource[]) {
    const errors: string[] = [];
    const badFormat = sources.filter((s) => !SUPPORTED_EXTS.includes(s.ext.toLowerCase()));
    if (badFormat.length > 0) {
      errors.push(
        `${badFormat.map((s) => s.fileName).join(", ")} — only ${SUPPORTED_EXTS.join("/")} are supported and was skipped.`,
      );
    }
    const supported = sources.filter((s) => SUPPORTED_EXTS.includes(s.ext.toLowerCase()));
    const tooBig = supported.filter((s) => s.byteLength > MAX_AUDIO_BYTES);
    const accepted = supported.filter((s) => s.byteLength <= MAX_AUDIO_BYTES);
    if (tooBig.length > 0) {
      const limitMb = Math.round(MAX_AUDIO_BYTES / 1024 / 1024);
      errors.push(
        `${tooBig.map((s) => s.fileName).join(", ")} exceeds the ${limitMb} MB limit and was skipped.`,
      );
    }
    if (errors.length > 0) setPickError(errors.join(" "));
    if (accepted.length === 0) return;
    const newEntries: FileEntry[] = accepted.map((source) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      source,
    }));
    setEntries((prev) => [...prev, ...newEntries]);
    // Adding a single file (a timeline clip or one project item) jumps straight into its tab so the
    // user can Separate it right away, instead of landing on the list with an extra click.
    if (newEntries.length === 1) setSelectedId(newEntries[0].id);
  }

  function removeEntry(id: string) {
    // The card (FileCard.handleRemove) deletes the saved separation server-side; here we just
    // drop it from the panel list.
    setEntries((prev) => prev.filter((e) => e.id !== id));
    // If the open tab was removed, fall back to the main list.
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  // Only treat a selection as "open" if it still points at a live entry — a stale selectedId can
  // then never strand the panel on a blank detail view.
  const openId = selectedId != null && entries.some((e) => e.id === selectedId) ? selectedId : null;

  return (
    <div className="panel">
      {/* Brand header (logo + credits + Logout) is main-list chrome — hidden while viewing a
          file's tab, where the back button + file content stand on their own. */}
      {openId == null && (
        <header className="panel-header">
          <BrandLockup size={22} />
          <div className="panel-header-right">
            {balance != null &&
              (BILLING_ENABLED ? (
                <button className="credit-badge credit-badge--button" type="button" onClick={() => setBuyOpen(true)}>
                  {balance} credits +
                </button>
              ) : (
                <span className="credit-badge">{balance} credits</span>
              ))}
            <sp-button variant="secondary" treatment="outline" size="s" onClick={onSignOut}>
              Logout
            </sp-button>
          </div>
        </header>
      )}

      {buyOpen && (
        <BuyCreditsModal
          onClose={() => {
            setBuyOpen(false);
            // 사용자가 모바일 앱에서 충전하고 돌아오면 잔액이 자동 반영되도록 잠시 폴링.
            pollBalanceAfterCheckout();
          }}
        />
      )}

      {openId == null && (
        <SourcePicker
          loading={pickerBusy}
          onPickTimeline={onAddFromPremiere}
          onPickProject={() => {
            setBrowseOpen(true);
            setBrowseNonce((n) => n + 1); // re-press reloads even when already open
          }}
        />
      )}

      {browseOpen && (
        <ProjectBrowser
          key={browseNonce}
          onClose={() => setBrowseOpen(false)}
          onImport={(sources) => addEntries(sources)}
        />
      )}

      {openId == null && restoring && (
        <p className="panel-status">Restoring your previous work…</p>
      )}
      {openId == null && pickStatus && <p className="panel-status">{pickStatus}</p>}
      {openId == null && pickError && <p className="panel-error">{pickError}</p>}

      {openId == null && entries.length > 0 && (
        <h2 className="file-list-title">Your files</h2>
      )}

      <ul className="file-cards">
        {entries.map((entry) => {
          const view: CardView =
            openId == null ? "row" : entry.id === openId ? "detail" : "hidden";
          return (
            <li key={entry.id} className={view === "hidden" ? "file-card-hidden" : undefined}>
              <FileCard
                entry={entry}
                projectKey={projectKey}
                view={view}
                onOpen={() => setSelectedId(entry.id)}
                onBack={() => setSelectedId(null)}
                onRemove={() => removeEntry(entry.id)}
                onCreditChange={refreshBalance}
                onBuyCredits={BILLING_ENABLED ? () => setBuyOpen(true) : undefined}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface SourcePickerProps {
  loading: boolean;
  onPickTimeline: () => void;
  onPickProject: () => void;
}

// Tiny rect-only icons — UXP renders <rect>, not SVG <path> or sp-icon. Project = a list of
// items; Timeline = a track with the selected clip highlighted.
function ProjectIcon() {
  return (
    <svg className="source-cell-icon" width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
      <rect x="2" y="3" width="11" height="2.2" rx="1.1" fill="#e4e4e4" />
      <rect x="2" y="6.4" width="11" height="2.2" rx="1.1" fill="#e4e4e4" />
      <rect x="2" y="9.8" width="11" height="2.2" rx="1.1" fill="#e4e4e4" />
    </svg>
  );
}

function TimelineIcon() {
  return (
    <svg className="source-cell-icon" width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
      <rect x="1.5" y="6.4" width="12" height="2.2" rx="1.1" fill="#e4e4e4" opacity="0.45" />
      <rect x="5" y="3.4" width="4.6" height="8.2" rx="1.2" fill="#e4e4e4" />
    </svg>
  );
}

// Two buttons to bring audio into the panel: Project (pick a bin item) and Timeline (read the
// current selection). No OS drag-and-drop — UXP panels don't receive dropped files.
function SourcePicker({ loading, onPickTimeline, onPickProject }: SourcePickerProps) {
  // Plain <div role="button">, not <button>: UXP's native <button> paints rounded-gray chrome
  // that CSS can't override. role/tabIndex/onKeyDown keep each div operable like a real button.
  const cell = (onClick: () => void) => ({
    className: `source-cell${loading ? " source-cell--disabled" : ""}`,
    role: "button",
    tabIndex: loading ? -1 : 0,
    onClick: loading ? undefined : onClick,
    onKeyDown: loading
      ? undefined
      : (e: ReactKeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        },
  });
  return (
    <div className="source-bar" role="group" aria-label="Add audio to separate">
      <div {...cell(onPickProject)}>
        <ProjectIcon />
        Browse project items
      </div>
      <div {...cell(onPickTimeline)}>
        <TimelineIcon />
        Load selected timeline clip
      </div>
    </div>
  );
}

