import {
  getProgress,
  getProjectInfo,
  getSeparationDownloadLinks,
  streamDownload,
  submitAudioSeparation,
  uploadAudio,
} from "../perso/persoClient.js";
import { extractTar } from "../perso/tar.js";
import { updateJob } from "./jobStore.js";
import { putStemBytes } from "./stemStore.js";
import { transcodeToWav } from "../util/transcode.js";
import { refund, type BillingRef } from "../credit/creditStore.js";

export type { BillingRef };

export interface SeparatedStemMeta {
  stemId: string;
  label: string;
}

export interface SeparationResult {
  stems: SeparatedStemMeta[];
  // The Perso project this separation ran in — kept so "Check script" can read the diarized
  // script the separation already produced (GET .../audio-separation/script) without a new job.
  projectSeq: number;
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 15000;
const MAX_POLL_MS = 30 * 60 * 1000;
const READINESS_TIMEOUT_MS = 60 * 1000;

export async function runSeparationJob(
  jobId: string,
  audio: ArrayBuffer,
  fileName: string,
  billing?: BillingRef,
): Promise<void> {
  try {
    await updateJob(jobId, { status: "processing", progress: 5, progressReason: "Uploading" });
    const media = await uploadAudio(audio, fileName);

    await updateJob(jobId, { progress: 15, progressReason: "Submitting" });
    const projectSeq = await submitAudioSeparation(media.seq, fileName);

    await updateJob(jobId, { progress: 25, progressReason: "Separating" });
    const deadline = Date.now() + MAX_POLL_MS;
    let delay = POLL_INTERVAL_MS;
    while (Date.now() < deadline) {
      const p = await getProgress(projectSeq);
      if (p.hasFailed || p.progressReason === "Failed") {
        throw new Error(`Perso separation failed: ${p.progressReason ?? "unknown"}`);
      }
      await updateJob(jobId, {
        progress: Math.min(88, 25 + Math.round((p.progress ?? 0) * 0.6)),
        progressReason: p.progressReason ?? "Separating",
      });
      if (p.progressReason === "Completed") break;
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), MAX_POLL_INTERVAL_MS);
    }
    if (Date.now() >= deadline) throw new Error("separation timed out");

    await updateJob(jobId, { progress: 90, progressReason: "Finalizing" });
    const info = await waitForReadiness(projectSeq);

    await updateJob(jobId, { progress: 95, progressReason: "Downloading" });
    const links = await getSeparationDownloadLinks(projectSeq, "originalVoiceSpeakers");
    const link = links.audioFile?.voiceAudioDownloadLink;
    if (!link) throw new Error("Perso originalVoiceSpeakers link absent");
    const tar = await streamDownload(link);
    const files = extractTar(tar).sort((a, b) => a.name.localeCompare(b.name));
    if (files.length === 0) throw new Error("no speaker files extracted from tar");

    const stems: SeparatedStemMeta[] = [];
    for (const [idx, file] of files.entries()) {
      const stemId = `speaker_${idx}`;
      // Normalize to standard PCM WAV so the panel can read/play it (tar stems aren't always WAV).
      await putStemBytes(jobId, stemId, await transcodeToWav(file.bytes));
      stems.push({ stemId, label: `Speaker ${idx + 1}` });
    }

    const bgPath = info.downloadPathInfo?.originalBackgroundPath;
    if (bgPath) {
      try {
        const bg = await streamDownload(bgPath);
        await putStemBytes(jobId, "background", await transcodeToWav(bg));
        stems.push({ stemId: "background", label: "Background" });
      } catch (e) {
        console.warn("[separation] background download failed, continuing:", e);
      }
    }

    await updateJob(jobId, { status: "ready", progress: 100, progressReason: "Done", result: { stems, projectSeq } });
  } catch (e) {
    // The route charges credits up-front; refund them when the job fails so the
    // user isn't billed for work they never received. Idempotent via the ledger ref.
    if (billing) {
      await refund(billing.ownerSub, billing.cost, `refund:${jobId}`).catch((err) =>
        console.error("[separation] refund failed:", err),
      );
    }
    await updateJob(jobId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
}

async function waitForReadiness(projectSeq: number) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let latest = await getProjectInfo(projectSeq);
  while (Date.now() < deadline) {
    if (latest.downloadInfo?.hasOriginalSpeakerAudioCollection) return latest;
    await sleep(POLL_INTERVAL_MS);
    latest = await getProjectInfo(projectSeq);
  }
  if (!latest.downloadInfo?.hasOriginalSpeakerAudioCollection) {
    throw new Error("speaker stems never became ready");
  }
  return latest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
