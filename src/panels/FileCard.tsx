import { useEffect, useRef, useState } from "react";
import type { LoadedAudioSource } from "../input/audioPicker";
import { StemListView, type StemView } from "./StemListView";
import { MixOutputView, type MixResult } from "./MixOutputView";
import { Waveform } from "./Waveform";
import { decodeAndComputePeaks } from "../audio/waveform";
import { mixStems } from "../audio/mixer";
import { playbackSupported } from "../audio/player";
import { runSeparation, fetchSeparationScript } from "../jobs/separationClient";
import { fetchPeaks } from "../jobs/peaksClient";
import { segmentSpeaker } from "../jobs/segmentClient";
import { ScriptEditor } from "./ScriptEditor";
import type { ScriptDraft } from "../types/job";
import { InsufficientCreditsError } from "../jobs/creditClient";
import { importAudioToProject, importAudioToTimeline, type AudioToImport } from "../host/premiere";
import { makeAudioUrl, revokeAudioUrl, audioUrlToBytes } from "../audio/audioUrl";

type ImportTarget = "project" | "timeline";

// Mirror of the server's pricing (server/src/credit/creditStore.ts creditsForDuration):
// 1 credit per minute, rounded up, minimum 1. Shown on the Separate button.
function creditsForDuration(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 1;
  return Math.max(1, Math.ceil(durationSec / 60));
}

// Waveform peaks for arbitrary audio: try the pure-JS WAV path first (instant, no network),
// fall back to the server (ffmpeg) for anything it can't decode — mp3/m4a, and Perso speaker
// stems that aren't plain PCM WAV. Always resolves to *some* peaks so the bar renders.
async function loadPeaks(
  bytes: ArrayBuffer,
  fileName: string,
): Promise<{ peaks: Float32Array; durationSec: number }> {
  let decoded: Awaited<ReturnType<typeof decodeAndComputePeaks>> | null = null;
  try {
    decoded = await decodeAndComputePeaks(bytes);
  } catch {
    decoded = null;
  }
  if (decoded && decoded.status === "ok") {
    return { peaks: decoded.peaks, durationSec: decoded.durationSec };
  }
  try {
    const remote = await fetchPeaks(bytes, fileName);
    return { peaks: remote.peaks, durationSec: remote.durationSec || (decoded?.durationSec ?? 0) };
  } catch (e) {
    console.warn("[peaks] server fallback failed:", e);
    return { peaks: decoded?.peaks ?? new Float32Array(0), durationSec: decoded?.durationSec ?? 0 };
  }
}

export interface FileEntry {
  id: string;
  source: LoadedAudioSource;
}

interface Props {
  entry: FileEntry;
  onRemove: () => void;
  onCreditChange?: () => void;
  onBuyCredits?: () => void;
}

type Stage =
  | { kind: "prepping" }
  | { kind: "generating"; progress: number; reason: string | null }
  | { kind: "done"; stems: StemView[]; mix: MixResult | null }
  | { kind: "error"; message: string; buyable?: boolean };


const MIX_ID = "mix";

export function FileCard({ entry, onRemove, onCreditChange, onBuyCredits }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "prepping" });
  const [collapsed, setCollapsed] = useState(false);
  const [mixBusy, setMixBusy] = useState(false);
  const [mixError, setMixError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState<ImportTarget | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const [basePeaks, setBasePeaks] = useState<Float32Array | null>(null);
  const [durationSec, setDurationSec] = useState(0);
  const [prepFailed, setPrepFailed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [separationJobId, setSeparationJobId] = useState<string | null>(null);
  // Collapsible "Check script" editor. The working draft lives here (not inside ScriptEditor) so
  // collapsing/expanding keeps edits; it's fetched once and reused. Cleared on a fresh separation.
  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptDraft, setScriptDraft] = useState<ScriptDraft | null>(null);
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptBusy, setScriptBusy] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPrepFailed(false);
    (async () => {
      let decoded;
      try {
        decoded = await decodeAndComputePeaks(entry.source.bytes);
      } catch {
        if (!cancelled) setPrepFailed(true);
        return;
      }
      if (cancelled) return;
      if (decoded.status === "failed") {
        setPrepFailed(true); // genuinely unreadable input — surface it, don't fake a waveform.
        return;
      }
      // Show whatever we have locally first (real WAV peaks, or a flat mp3/m4a placeholder).
      setBasePeaks(decoded.peaks);
      setDurationSec(decoded.durationSec);
      // Local couldn't decode (mp3/m4a in UXP) → upgrade to the server-computed waveform.
      if (decoded.status !== "ok") {
        try {
          const remote = await fetchPeaks(entry.source.bytes, entry.source.fileName);
          if (cancelled) return;
          setBasePeaks(remote.peaks);
          if (remote.durationSec > 0) setDurationSec(remote.durationSec);
        } catch (e) {
          console.warn("[prep] remote peaks failed, keeping placeholder:", e);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.source]);

  // Each audio handle pins its underlying WAV buffer (multi-MB per stem) until revoked. Track
  // them and revoke on unmount, plus eagerly when superseded. makeAudioUrl/revokeAudioUrl keep
  // the bytes in a registry so playback/preview/import never depend on fetch(objectURL) — which
  // is unverified in UXP (KNOWN_ISSUES) — see audio/audioUrl.ts.
  const objectUrls = useRef<Set<string>>(new Set());
  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      urls.forEach((u) => revokeAudioUrl(u));
      urls.clear();
    };
  }, []);
  function makeObjectUrl(bytes: ArrayBuffer): string {
    const url = makeAudioUrl(bytes);
    objectUrls.current.add(url);
    return url;
  }
  function revokeObjectUrl(url: string | null | undefined): void {
    if (url && objectUrls.current.delete(url)) revokeAudioUrl(url);
  }
  function revokeStageUrls(s: Stage): void {
    if (s.kind !== "done") return;
    s.stems.forEach((st) => revokeObjectUrl(st.audioUrl));
    revokeObjectUrl(s.mix?.audioUrl);
  }

  async function onGenerate() {
    // Re-running supersedes any previous stems/mix — free their buffers first.
    setScriptOpen(false);
    setScriptDraft(null); // new separation → forget prior script + edits
    setScriptError(null);
    setStage((prev) => {
      revokeStageUrls(prev);
      return { kind: "generating", progress: 0, reason: null };
    });
    try {
      const durationMs = Math.round(durationSec * 1000);
      const { stems: separated, jobId } = await runSeparation(
        entry.source.bytes,
        entry.source.fileName,
        durationMs,
        (progress, reason) =>
          setStage((prev) =>
            prev.kind === "generating" ? { ...prev, progress, reason } : prev,
          ),
      );
      setSeparationJobId(jobId);
      const stems: StemView[] = await Promise.all(
        separated.map(async (s, idx) => {
          const loaded = await loadPeaks(s.bytes, `${s.label || "stem"}.wav`);
          const url = makeObjectUrl(s.bytes);
          return {
            id: s.stemId,
            label: s.label,
            volume: 100,
            selected: idx === 0,
            peaks: loaded.peaks,
            audioUrl: url,
            durationSec: loaded.durationSec,
          };
        }),
      );
      setStage({ kind: "done", stems, mix: null });
    } catch (e) {
      if (e instanceof InsufficientCreditsError) {
        setStage({
          kind: "error",
          message: `Not enough credits — need ${e.required}, have ${e.balance}.`,
          buyable: true,
        });
      } else {
        setStage({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      onCreditChange?.();
    }
  }

  function updateStem(stemId: string, partial: Partial<StemView>) {
    setStage((prev) => {
      if (prev.kind !== "done") return prev;
      return {
        ...prev,
        stems: prev.stems.map((s) => (s.id === stemId ? { ...s, ...partial } : s)),
      };
    });
  }

  async function mixSelected() {
    if (stage.kind !== "done") return;
    const selected = stage.stems.filter((s) => s.selected && s.audioUrl);
    if (selected.length === 0) return;
    setMixBusy(true);
    try {
      const bytes = await mixStems(
        selected.map((s) => ({ audioUrl: s.audioUrl!, volume: s.volume })),
      );
      const loaded = await loadPeaks(bytes, "mix.wav");
      const audioUrl = makeObjectUrl(bytes);
      const mix: MixResult = {
        id: `mix-${Date.now()}`,
        name: `${entry.source.fileName.replace(/\.[^.]+$/, "")} - mix.wav`,
        byteLength: bytes.byteLength,
        stemCount: selected.length,
        peaks: loaded.peaks,
        audioUrl,
        durationSec: loaded.durationSec,
      };
      setStage((prev) => {
        if (prev.kind !== "done") return prev;
        revokeObjectUrl(prev.mix?.audioUrl); // replacing a prior mix
        return { ...prev, mix };
      });
    } catch (e) {
      setMixError(e instanceof Error ? e.message : String(e));
    } finally {
      setMixBusy(false);
    }
  }

  // "Check script" is a toggle: collapse if open; expand otherwise, fetching the diarized script
  // the separation already produced (fast — no STT job) the first time only. Edits persist in
  // scriptDraft, so collapsing/reopening keeps them.
  async function toggleScript() {
    if (scriptOpen) {
      setScriptOpen(false);
      return;
    }
    setScriptOpen(true);
    if (scriptDraft || scriptLoading || !separationJobId) return;
    setScriptLoading(true);
    setScriptError(null);
    try {
      setScriptDraft(await fetchSeparationScript(separationJobId));
    } catch (e) {
      setScriptError(e instanceof Error ? e.message : String(e));
    } finally {
      setScriptLoading(false);
    }
  }

  // Regenerate one isolated track per (edited) speaker by cutting the original to that speaker's
  // segment time ranges, then replace the voice stems with the script-based set (keeping background).
  async function regenerateFromScript() {
    const draft = scriptDraft;
    if (!draft || scriptBusy) return;
    setScriptBusy(true);
    setScriptError(null);
    try {
      const newStems: StemView[] = [];
      for (const sp of draft.speakers) {
        const ranges = draft.segments
          .filter((seg) => seg.speakerIndex === sp.index)
          .map((seg) => ({ startMs: seg.startMs, endMs: seg.endMs }));
        const bytes = await segmentSpeaker(entry.source.bytes, ranges);
        const loaded = await loadPeaks(bytes, `${sp.label || "speaker"}.wav`);
        const url = makeObjectUrl(bytes);
        newStems.push({
          id: `spk-${sp.index}`,
          label: sp.label || `화자 ${sp.index}`,
          volume: 100,
          selected: newStems.length === 0,
          peaks: loaded.peaks,
          audioUrl: url,
          durationSec: loaded.durationSec,
        });
      }
      setStage((prev) => {
        if (prev.kind !== "done") return prev;
        // Keep the original background stem — the script only re-cuts the speaker voices, the
        // separated background music should still be available alongside them.
        const background = prev.stems.find((s) => s.id === "background") ?? null;
        prev.stems.forEach((st) => {
          if (st.id !== "background") revokeObjectUrl(st.audioUrl); // free superseded voice stems only
        });
        revokeObjectUrl(prev.mix?.audioUrl);
        const stems = background ? [...newStems, background] : newStems;
        return { kind: "done", stems, mix: null };
      });
    } catch (e) {
      setScriptError(e instanceof Error ? e.message : String(e));
    } finally {
      setScriptBusy(false);
    }
  }

  function renameMix(name: string) {
    setStage((prev) => {
      if (prev.kind !== "done" || !prev.mix) return prev;
      return { ...prev, mix: { ...prev.mix, name } };
    });
  }

  function discardMix() {
    setStage((prev) => {
      if (prev.kind !== "done") return prev;
      revokeObjectUrl(prev.mix?.audioUrl);
      return { ...prev, mix: null };
    });
  }

  async function runImport(target: ImportTarget, items: AudioToImport[], label: string) {
    if (items.length === 0) return;
    setImportError(null);
    setImportNotice(null);
    setImportBusy(target);
    try {
      if (target === "project") await importAudioToProject(items);
      else await importAudioToTimeline(items);
      const where = target === "project" ? "Project panel" : "timeline";
      setImportNotice(`Added ${label} to the ${where}.`);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(null);
    }
  }

  async function importMix(target: ImportTarget) {
    if (stage.kind !== "done" || !stage.mix) return;
    const item: AudioToImport = {
      fileName: stage.mix.name,
      bytes: await audioUrlToBytes(stage.mix.audioUrl),
    };
    await runImport(target, [item], "mix");
  }

  function requestActive(id: string, active: boolean) {
    setActiveId(active ? id : (prev) => (prev === id ? null : prev));
  }

  const sizeMb = (entry.source.byteLength / 1024 / 1024).toFixed(1);

  return (
    <div className={`file-card${collapsed ? " file-card--collapsed" : ""}`}>
      <div className="file-card-header">
        <button
          className="file-card-toggle"
          aria-label={collapsed ? "Expand" : "Collapse"}
          type="button"
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? "▶" : "▼"}
        </button>
        <div className="file-card-info">
          <p className="file-card-name">{entry.source.fileName}</p>
          <p className="file-card-meta">{entry.source.ext.toUpperCase()} · {sizeMb} MB</p>
        </div>
        <div className="file-card-actions">
          <button
            className="file-card-remove"
            aria-label="Remove file"
            type="button"
            onClick={onRemove}
          >
            ×
          </button>
        </div>
      </div>

      {!collapsed && stage.kind === "prepping" && prepFailed && (
        <div className="file-card-body">
          <sp-help-text variant="negative">
            Couldn't read this audio file — it may be corrupt or an unsupported format. Try a different file.
          </sp-help-text>
        </div>
      )}

      {!collapsed && stage.kind === "prepping" && !prepFailed && (
        <div className="file-card-body">
          <div className="waveform-preview">
            <Waveform peaks={basePeaks} selected progress={0} />
          </div>
          <div className="prepping-actions">
            <span className="prepping-cost">
              {durationSec > 0
                ? `Costs ${creditsForDuration(durationSec)} credit${creditsForDuration(durationSec) === 1 ? "" : "s"}`
                : "Reading audio…"}
            </span>
            <sp-button variant="accent" disabled={basePeaks == null ? true : undefined} onClick={onGenerate}>
              Separate
            </sp-button>
          </div>
        </div>
      )}

      {!collapsed && stage.kind === "generating" && (
        <div className="file-card-body">
          <ul className="job-progress-list">
            <li className="job-progress-row">
              <span className="job-progress-label">{stage.reason ?? "Stem separation"}</span>
              {stage.progress > 0 && (
                <span className="job-progress-pct">{Math.round(stage.progress)}%</span>
              )}
            </li>
          </ul>
        </div>
      )}

      {!collapsed && stage.kind === "done" && (
        <div className="file-card-body">
          <DoneSummary durationSec={durationSec} />

          <div
            className="script-toggle"
            role="button"
            tabIndex={0}
            aria-expanded={scriptOpen}
            onClick={toggleScript}
          >
            <span className="script-toggle-caret">{scriptOpen ? "▾" : "▸"}</span>
            <span className="script-toggle-label">Check script</span>
            <span className="script-toggle-hint">edit speakers &amp; rebuild audio</span>
          </div>
          {scriptOpen && scriptLoading && <p className="script-bar-status">Reading script…</p>}
          {scriptOpen && scriptError && <p className="panel-error">{scriptError}</p>}
          {scriptOpen && scriptDraft && (
            <ScriptEditor
              draft={scriptDraft}
              busy={scriptBusy}
              onChange={setScriptDraft}
              onRegenerate={regenerateFromScript}
            />
          )}

          {stage.mix && (
            <MixOutputView
              result={stage.mix}
              isActive={activeId === MIX_ID}
              onRequestActive={(active) => requestActive(MIX_ID, active)}
              onDiscard={discardMix}
              onRename={renameMix}
              importBusy={importBusy}
              onImport={importMix}
            />
          )}
          <MixControls
            selectedCount={stage.stems.filter((s) => s.selected).length}
            busy={mixBusy}
            onMix={mixSelected}
          />
          {mixError && <sp-help-text variant="negative">{mixError}</sp-help-text>}
          {importError && <sp-help-text variant="negative">{importError}</sp-help-text>}
          {importNotice && <sp-help-text>{importNotice}</sp-help-text>}
          {!playbackSupported() && (
            <sp-help-text>
              In-panel preview isn't available in this Premiere version — add a stem to the timeline to listen.
            </sp-help-text>
          )}
          <StemListView
            stems={stage.stems}
            activeId={activeId}
            onRequestActive={requestActive}
            onVolumeChange={(id, volume) => updateStem(id, { volume })}
            onToggleSelected={(id, selected) => updateStem(id, { selected })}
          />
        </div>
      )}

      {!collapsed && stage.kind === "error" && (
        <div className="file-card-body">
          <sp-help-text variant="negative">{stage.message}</sp-help-text>
          {stage.buyable && onBuyCredits && (
            <sp-button variant="accent" size="s" onClick={onBuyCredits}>
              Buy credits
            </sp-button>
          )}
        </div>
      )}
    </div>
  );
}

interface DoneSummaryProps {
  durationSec: number;
}

function DoneSummary({ durationSec }: DoneSummaryProps) {
  return (
    <div className="done-summary">
      <div className="done-summary-info">
        <p className="done-summary-jobs">Stem separation</p>
        <p className="done-summary-meta">{formatDuration(durationSec)}</p>
      </div>
    </div>
  );
}

function formatDuration(durationSec: number): string {
  const m = Math.floor(durationSec / 60);
  const s = Math.floor(durationSec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

interface MixControlsProps {
  selectedCount: number;
  busy: boolean;
  onMix: () => void;
}

function MixControls({ selectedCount, busy, onMix }: MixControlsProps) {
  return (
    <div className="mix-controls">
      <span className="mix-controls-count">
        {selectedCount} {selectedCount === 1 ? "stem" : "stems"} selected
      </span>
      <sp-button
        variant="accent"
        disabled={selectedCount === 0 || busy || undefined}
        pending={busy || undefined}
        onClick={onMix}
      >
        Mix selected
      </sp-button>
    </div>
  );
}
