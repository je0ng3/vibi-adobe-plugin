import { useEffect, useRef, useState } from "react";
import { pickAudiosFromOs, SUPPORTED_EXTS, type LoadedAudioSource } from "../input/audioPicker";
import { readSelectedAudioClips, getActiveProjectKey } from "../host/premiere";
import { listSeparations } from "../jobs/separationClient";
import { ProjectBrowser } from "./ProjectBrowser";
import { FileCard, type FileEntry } from "./FileCard";
import { getBalance } from "../jobs/creditClient";
import { BuyCreditsModal } from "./BuyCreditsModal";
import { BrandLockup } from "../brand/Logo";
import { MAX_AUDIO_BYTES, BILLING_ENABLED } from "../config";

interface Props {
  onSignOut: () => void;
}

export function SeparationPanel({ onSignOut }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  // Transient progress while a video clip's audio is extracted via Adobe Media Encoder.
  const [pickStatus, setPickStatus] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
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
      const key = await getActiveProjectKey();
      if (cancelled) return;
      setProjectKey(key);
      try {
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
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  async function onAddFiles() {
    setPickError(null);
    setPickerBusy(true);
    try {
      const sources = await pickAudiosFromOs({ onStatus: setPickStatus });
      if (sources.length === 0) return;
      addEntries(sources);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setPickerBusy(false);
      setPickStatus(null);
    }
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
  }

  function removeEntry(id: string) {
    // The card (FileCard.handleRemove) deletes the saved separation server-side; here we just
    // drop it from the panel list.
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  return (
    <div className="panel">
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
            Sign out
          </sp-button>
        </div>
      </header>

      {buyOpen && (
        <BuyCreditsModal
          onClose={() => {
            setBuyOpen(false);
            // 사용자가 모바일 앱에서 충전하고 돌아오면 잔액이 자동 반영되도록 잠시 폴링.
            pollBalanceAfterCheckout();
          }}
        />
      )}

      <SourcePicker
        loading={pickerBusy}
        onPickFile={onAddFiles}
        onPickTimeline={onAddFromPremiere}
        onPickProject={() => setBrowseOpen(true)}
      />

      {browseOpen && (
        <ProjectBrowser
          onClose={() => setBrowseOpen(false)}
          onImport={(sources) => addEntries(sources)}
        />
      )}

      {pickStatus && <p className="panel-status">{pickStatus}</p>}
      {pickError && <p className="panel-error">{pickError}</p>}

      <ul className="file-cards">
        {entries.map((entry) => (
          <li key={entry.id}>
            <FileCard
              entry={entry}
              projectKey={projectKey}
              onRemove={() => removeEntry(entry.id)}
              onCreditChange={refreshBalance}
              onBuyCredits={BILLING_ENABLED ? () => setBuyOpen(true) : undefined}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SourcePickerProps {
  loading: boolean;
  onPickFile: () => void;
  onPickTimeline: () => void;
  onPickProject: () => void;
}

// Three ways to bring audio into the panel as one divided control: File fills the tall left cell,
// Project (top) and Timeline (bottom) split the right. The whole cell is the click target.
// No OS drag-and-drop: UXP panels don't receive dropped files, so every source is a click.
function SourcePicker({ loading, onPickFile, onPickTimeline, onPickProject }: SourcePickerProps) {
  // Plain <div>, not <button>: UXP's native <button> has built-in rounded-gray chrome that CSS
  // background/border-radius can't override, so the cells looked like gray pills. A div has no
  // default chrome and styles cleanly. role/tabIndex keep it operable.
  const cell = (cls: string, onClick: () => void) => ({
    className: `source-cell ${cls}${loading ? " source-cell--disabled" : ""}`,
    role: "button",
    tabIndex: loading ? -1 : 0,
    onClick: loading ? undefined : onClick,
  });
  return (
    <div className="source-bar" role="group" aria-label="Add audio from">
      <div {...cell("source-cell--file", onPickFile)}>File</div>
      <div className="source-divider source-divider--v" aria-hidden />
      <div className="source-col">
        <div {...cell("source-cell--project", onPickProject)}>Project</div>
        <div className="source-divider source-divider--h" aria-hidden />
        <div {...cell("source-cell--timeline", onPickTimeline)}>Timeline</div>
      </div>
    </div>
  );
}

