import { useEffect, useRef, useState } from "react";
import type { LoadedAudioSource } from "../input/audioPicker";
import { StemListView, type StemView } from "./StemListView";
import { MixOutputView, type MixResult } from "./MixOutputView";
import { Waveform } from "./Waveform";
import { decodeAndComputePeaks } from "../audio/waveform";
import { mixStems } from "../audio/mixer";
import { playbackSupported } from "../audio/player";
import {
  runSeparation,
  fetchSeparationScript,
  fetchStem,
  deleteSeparation,
  type SavedSeparation,
} from "../jobs/separationClient";
import { fetchPeaks } from "../jobs/peaksClient";
import { segmentSpeaker } from "../jobs/segmentClient";
import { ScriptEditor } from "./ScriptEditor";
import type { ScriptDraft } from "../types/job";
import { defaultSpeakerLabel, stemDisplayLabel } from "../types/job";
import { InsufficientCreditsError } from "../jobs/creditClient";
import { importAudioToProject, importAudioToTimeline, type AudioToImport } from "../host/premiere";
import { makeAudioUrl, revokeAudioUrl, audioUrlToBytes } from "../audio/audioUrl";
import { formatClock, formatMb } from "../audio/format";
import { diag } from "../diag";

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
  // A freshly added file (has its bytes, can be separated) OR a history-restored entry (no
  // source bytes — `restored` carries the saved metadata, and stems fetch from the server).
  source: LoadedAudioSource | null;
  restored?: SavedSeparation;
}

// "row" = compact selectable row in the main list; "detail" = the opened tab (full body);
// "hidden" = a different file's tab is open. Hidden cards stay MOUNTED (render null) so their
// in-flight separation and already-loaded stems survive navigating between files.
export type CardView = "row" | "detail" | "hidden";

interface Props {
  entry: FileEntry;
  projectKey: string | null;
  view: CardView;
  onOpen: () => void;
  onBack: () => void;
  onRemove: () => void;
  onCreditChange?: () => void;
  onBuyCredits?: () => void;
}

type Stage =
  | { kind: "prepping" }
  | { kind: "restoring" }
  | { kind: "generating"; progress: number; reason: string | null }
  | { kind: "done"; stems: StemView[]; mix: MixResult | null }
  | { kind: "error"; message: string; buyable?: boolean };


const MIX_ID = "mix";

export function FileCard({ entry, projectKey, view, onOpen, onBack, onRemove, onCreditChange, onBuyCredits }: Props) {
  // File identity comes from the live source when added fresh, or from saved metadata when this
  // card was rehydrated from history (no source bytes).
  const meta = entry.source
    ? { fileName: entry.source.fileName, ext: entry.source.ext, byteLength: entry.source.byteLength }
    : {
        fileName: entry.restored?.fileName ?? "audio",
        ext: (entry.restored?.fileName ?? "").split(".").pop() ?? "",
        byteLength: entry.restored?.byteLength ?? 0,
      };
  const [stage, setStage] = useState<Stage>(entry.restored ? { kind: "restoring" } : { kind: "prepping" });
  // Expanded only when this card is the open tab. Restored history cards still load their stems
  // lazily — gated on this — so opening the panel with many saved separations doesn't pull every
  // stem into memory; each one's stems fetch on first open.
  const collapsed = view !== "detail";
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
    if (!entry.source) return; // restored card — no original bytes to prep a waveform from
    const source = entry.source;
    let cancelled = false;
    setPrepFailed(false);
    (async () => {
      let decoded;
      try {
        decoded = await decodeAndComputePeaks(source.bytes);
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
          const remote = await fetchPeaks(source.bytes, source.fileName);
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

  // Turn stem bytes into a renderable StemView: compute peaks and mint a tracked audio handle.
  // Shared by all three producers (fresh separation, history restore, script re-cut) so the
  // StemView shape and defaults live in one place.
  async function buildStemView(
    bytes: ArrayBuffer,
    id: string,
    label: string,
    selected: boolean,
  ): Promise<StemView> {
    const loaded = await loadPeaks(bytes, `${label || "stem"}.wav`);
    return {
      id,
      label,
      volume: 100,
      selected,
      peaks: loaded.peaks,
      audioUrl: makeObjectUrl(bytes),
      durationSec: loaded.durationSec,
    };
  }

  // Rehydrate a history-restored card on first expand: fetch the saved stems from the server
  // (R2-backed, egress-free) and jump straight to the "done" view — peaks, playback, mix, import
  // all work off the in-memory registry as usual. Gated on `collapsed` so the network/memory cost
  // is only paid for cards the user opens, and run-once via the ref so re-expanding doesn't refetch.
  const restoreStartedRef = useRef(false);
  useEffect(() => {
    if (!entry.restored || collapsed || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const restored = entry.restored;
    let cancelled = false;
    let finished = false;
    (async () => {
      setDurationSec(restored.durationSec);
      setSeparationJobId(restored.jobId);
      const built = await Promise.all(
        restored.stems.map(async (m, idx): Promise<StemView | null> => {
          const bytes = await fetchStem(restored.jobId, m.stemId);
          if (cancelled) return null;
          return buildStemView(bytes, m.stemId, stemDisplayLabel(m.stemId, m.label), idx === 0);
        }),
      );
      if (cancelled) {
        // Collapsed mid-fetch: free any handles we did mint before bailing.
        built.forEach((s) => revokeObjectUrl(s?.audioUrl));
        return;
      }
      setStage({ kind: "done", stems: built.filter((s): s is StemView => s !== null), mix: null });
      finished = true;
    })().catch((e) => {
      finished = true;
      if (cancelled) return;
      console.warn("[history] restore failed:", e);
      setStage({ kind: "error", message: "Couldn't restore this saved result — it may have expired." });
    });
    return () => {
      cancelled = true;
      // Collapsed again before the fetch finished — allow a later expand to retry instead of
      // leaving the card stuck on "Restoring…".
      if (!finished) restoreStartedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, collapsed]);

  async function onGenerate() {
    const source = entry.source;
    if (!source) return; // restored cards have no original bytes — can't (re)separate
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
        source.bytes,
        source.fileName,
        durationMs,
        projectKey, // tags the job so it lands in this project's saved-separation history
        (progress, reason) =>
          setStage((prev) =>
            prev.kind === "generating" ? { ...prev, progress, reason } : prev,
          ),
      );
      setSeparationJobId(jobId);
      diag(`FileCard: building ${separated.length} stem view(s)`);
      const stems: StemView[] = await Promise.all(
        separated.map((s, idx) => buildStemView(s.bytes, s.stemId, stemDisplayLabel(s.stemId, s.label), idx === 0)),
      );
      diag(`FileCard: setStage done (${stems.length} stems)`);
      setStage({ kind: "done", stems, mix: null });
      // No client-side save: the server persisted this separation (and pushed stems to R2) when
      // the job completed, so it's already in this project's history for next sign-in.
    } catch (e) {
      diag(`FileCard ERROR: ${e instanceof Error ? e.message : String(e)}`);
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
        // Base name only (no ".wav"); the extension is appended at the display/import edges.
        name: `${meta.fileName.replace(/\.[^.]+$/, "")} - mix`,
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

  // Regenerate one isolated track per (edited) speaker by cutting that speaker's segment time
  // ranges out of the separated VOCALS, then replace the voice stems with the script-based set
  // (keeping background).
  async function regenerateFromScript() {
    const draft = scriptDraft;
    if (!draft || scriptBusy || stage.kind !== "done") return;
    setScriptBusy(true);
    setScriptError(null);
    try {
      // Cut from the separated vocals, NOT entry.source.bytes (the original mix). The original
      // still contains the background and every other voice, so slicing it by time would carry
      // that audio into each "speaker" track — mixing them back then doubles the background and
      // bleeds in sounds the user didn't select. The combined non-background stems ARE the
      // isolated voices, so re-cutting them keeps each speaker track clean.
      const voiceStems = stage.stems.filter((s) => s.id !== "background" && s.audioUrl);
      if (voiceStems.length === 0) throw new Error("No separated voice track to rebuild from.");
      const vocals =
        voiceStems.length === 1
          ? await audioUrlToBytes(voiceStems[0].audioUrl!)
          : await mixStems(voiceStems.map((s) => ({ audioUrl: s.audioUrl!, volume: 100 })));

      const newStems: StemView[] = [];
      for (const sp of draft.speakers) {
        const ranges = draft.segments
          .filter((seg) => seg.speakerIndex === sp.index)
          .map((seg) => ({ startMs: seg.startMs, endMs: seg.endMs }));
        const bytes = await segmentSpeaker(vocals, ranges);
        newStems.push(
          await buildStemView(bytes, `spk-${sp.index}`, sp.label || defaultSpeakerLabel(sp.index), newStems.length === 0),
        );
      }
      // Keep the original background stem — the script only re-cuts the speaker voices, the
      // separated background music should still be available alongside them.
      const background = stage.stems.find((s) => s.id === "background") ?? null;
      const finalStems = background ? [...newStems, background] : newStems;
      setStage((prev) => {
        if (prev.kind !== "done") return prev;
        prev.stems.forEach((st) => {
          if (st.id !== "background") revokeObjectUrl(st.audioUrl); // free superseded voice stems only
        });
        revokeObjectUrl(prev.mix?.audioUrl);
        return { kind: "done", stems: finalStems, mix: null };
      });
      // The script rebuild is a client-side re-cut and isn't uploaded — history keeps the original
      // separated stems. The script itself is server-side (projectSeq), so a restored card can
      // reopen "Check script" and rebuild again.
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

  async function runImport(
    target: ImportTarget,
    items: AudioToImport[],
    label: string,
    atSeconds?: number,
  ) {
    if (items.length === 0) return;
    setImportError(null);
    setImportNotice(null);
    setImportBusy(target);
    try {
      if (target === "project") await importAudioToProject(items);
      else await importAudioToTimeline(items, atSeconds);
      const where =
        target === "project"
          ? "Project panel"
          : atSeconds != null
            ? "timeline (at the clip's position)"
            : "timeline (at the playhead)";
      setImportNotice(`Added ${label} to the ${where}.`);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(null);
    }
  }

  async function importMix(target: ImportTarget) {
    if (stage.kind !== "done" || !stage.mix) return;
    // `name` is the base; guard an emptied field so the imported clip keeps a real name.
    const base = stage.mix.name.trim();
    // Read the mix bytes inside a guard: this await is outside runImport's try, so a failure here
    // (expired/unreadable audio handle) would otherwise be an unhandled rejection with no error UI.
    let item: AudioToImport;
    try {
      item = { fileName: `${base || "mix"}.wav`, bytes: await audioUrlToBytes(stage.mix.audioUrl) };
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
      return;
    }
    // If this card's audio came from a timeline selection, drop the mix back at that clip's
    // position; otherwise importAudioToTimeline falls back to the playhead.
    await runImport(target, [item], "mix", entry.source?.timelineStartSec);
  }

  function requestActive(id: string, active: boolean) {
    setActiveId(active ? id : (prev) => (prev === id ? null : prev));
  }

  // Leaving the open tab unmounts the stem/mix views (their cleanup stops playback), but activeId
  // would otherwise persist — so reopening would remount an "active" card and auto-replay from 0.
  // Clear it whenever this card isn't the open tab so reopening is silent. Also clear if the card
  // leaves the "done" view (re-separate / error) so a stale id can't point at a removed stem.
  useEffect(() => {
    if (view !== "detail") setActiveId(null);
  }, [view]);
  useEffect(() => {
    if (stage.kind !== "done") setActiveId(null);
  }, [stage.kind]);

  // Each card namespaces the shared playback backend by its unique entry id; stem ids alone repeat
  // across cards (every file has a "vocals"/"background"), which is what made one file's preview
  // play — or its progress bar advance — for another. See StemCard/MixOutputView.
  const cardKey = entry.id;

  // Remove the card from the panel, and — if it corresponds to a saved separation — permanently
  // delete that record server-side so it doesn't reappear on the next sign-in. A fresh card that
  // never finished separating has no jobId, so there's nothing to delete.
  function handleRemove() {
    const jobId = entry.restored?.jobId ?? separationJobId;
    if (jobId) void deleteSeparation(jobId).catch((e) => console.warn("[history] delete failed:", e));
    onRemove();
  }

  const sizeMb = formatMb(meta.byteLength);

  // One-glance status for the compact list row, so the user can pick without opening each tab.
  const rowStatus =
    prepFailed ? "Unreadable"
    : stage.kind === "restoring" ? "Saved"
    : stage.kind === "prepping" ? "Ready to separate"
    : stage.kind === "generating" ? `Separating… ${Math.round(stage.progress)}%`
    : stage.kind === "done" ? "Separated"
    : "Error";

  // A different file's tab is open: render nothing, but stay mounted so this card's in-flight
  // job and loaded stems survive.
  if (view === "hidden") return null;

  const deleteAction = (className: string, label: string) => (
    <div
      className={className}
      role="button"
      tabIndex={0}
      aria-label="Delete file"
      onClick={handleRemove}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleRemove();
        }
      }}
    >
      {label}
    </div>
  );

  return (
    <div className={`file-card file-card--${view}`}>
      {view === "detail" && (
        <div className="file-card-detail-top">
          <div
            className="file-card-back"
            role="button"
            tabIndex={0}
            onClick={onBack}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onBack();
              }
            }}
          >
            <span className="file-card-back-arrow" aria-hidden="true">
              ‹
            </span>
            All files
          </div>
          {deleteAction("file-card-delete", "Delete")}
        </div>
      )}
      <div className="file-card-header">
        {view === "row" ? (
          <>
            <div
              className="file-card-open"
              role="button"
              tabIndex={0}
              aria-label={`Open ${meta.fileName} — ${rowStatus}`}
              onClick={onOpen}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen();
                }
              }}
            >
              <div className="file-card-info">
                <p className="file-card-name">{meta.fileName}</p>
                <p className="file-card-meta">
                  {rowStatus} · {meta.ext.toUpperCase()} · {sizeMb} MB
                </p>
              </div>
              <span className="file-card-chevron" aria-hidden="true">
                ›
              </span>
            </div>
            <div className="file-card-actions">{deleteAction("file-card-remove", "✕")}</div>
          </>
        ) : (
          <div className="file-card-info">
            <p className="file-card-name">{meta.fileName}</p>
            {durationSec > 0 && (
              <p className="file-card-meta">{formatClock(durationSec, { padMinutes: true })}</p>
            )}
          </div>
        )}
      </div>

      {!collapsed && stage.kind === "prepping" && prepFailed && (
        <div className="file-card-body">
          <sp-help-text variant="negative">
            Couldn't read this audio file — it may be corrupt or an unsupported format. Try a different file.
          </sp-help-text>
        </div>
      )}

      {!collapsed && stage.kind === "restoring" && (
        <div className="file-card-body">
          <ul className="job-progress-list">
            <li className="job-progress-row">
              <span className="job-progress-label">Restoring saved result…</span>
            </li>
          </ul>
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
              <span className="job-progress-pct">{Math.round(stage.progress)}%</span>
            </li>
          </ul>
        </div>
      )}

      {!collapsed && stage.kind === "done" && (
        <div className="file-card-body">
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
              cardKey={cardKey}
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
            cardKey={cardKey}
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
          {/* 원본 바이트가 있는(복원이 아닌) 카드만 재분리 가능 — 실패한 분리를 같은 입력으로 재시도. */}
          {entry.source && (
            <sp-button variant={stage.buyable ? "secondary" : "accent"} size="s" onClick={onGenerate}>
              Retry
            </sp-button>
          )}
        </div>
      )}
    </div>
  );
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
        size="s"
        disabled={selectedCount === 0 || busy || undefined}
        pending={busy || undefined}
        onClick={onMix}
      >
        Mix selected
      </sp-button>
    </div>
  );
}
