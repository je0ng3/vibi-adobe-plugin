import {
  getDownloadInfo,
  getProgress,
  getTranslateDownloadLinks,
  streamDownload,
  submitTranslate,
  uploadAudio,
} from "../perso/persoClient.js";
import { updateJob } from "./jobStore.js";
import { putStemBytes } from "./stemStore.js";
import { refund, type BillingRef } from "../credit/creditStore.js";

export interface DubMeta {
  lang: string;
}

export interface DubResult {
  dubs: DubMeta[];
}

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 15000;
const MAX_POLL_MS = 30 * 60 * 1000;
const READINESS_TIMEOUT_MS = 60 * 1000;

export function dubStemId(lang: string): string {
  return `dub_${lang}`;
}

export async function runDubbingJob(
  jobId: string,
  audio: ArrayBuffer,
  fileName: string,
  sourceLanguage: string,
  targetLanguages: string[],
  numberOfSpeakers: number,
  billing?: BillingRef,
): Promise<void> {
  try {
    await updateJob(jobId, { status: "processing", progress: 5, progressReason: "Uploading" });
    const media = await uploadAudio(audio, fileName);

    const dubs: DubMeta[] = [];
    const total = targetLanguages.length;
    for (let i = 0; i < total; i++) {
      const lang = targetLanguages[i];
      const base = Math.round((i / Math.max(1, total)) * 90);
      await updateJob(jobId, { progress: 10 + base, progressReason: `Dubbing (${lang})` });

      const projectSeq = await submitTranslate(media.seq, sourceLanguage, [lang], numberOfSpeakers, fileName);
      await pollUntilComplete(projectSeq, lang);
      await waitForDubReadiness(projectSeq);

      const links = await getTranslateDownloadLinks(projectSeq);
      const link = pickDubLink(links);
      if (!link) throw new Error(`no translated audio link for ${lang}`);
      const bytes = await streamDownload(link);
      await putStemBytes(jobId, dubStemId(lang), bytes);
      dubs.push({ lang });
    }

    await updateJob(jobId, {
      status: "ready",
      progress: 100,
      progressReason: "Done",
      result: { dubs } satisfies DubResult,
    });
  } catch (e) {
    // Charged up-front by the route — refund on failure (idempotent via the ledger ref).
    if (billing) {
      await refund(billing.ownerSub, billing.cost, `refund:${jobId}`).catch((err) =>
        console.error("[dubbing] refund failed:", err),
      );
    }
    await updateJob(jobId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
}

function pickDubLink(links: Awaited<ReturnType<typeof getTranslateDownloadLinks>>): string | null {
  const a = links.audioFile;
  return (
    a?.translatedVoiceDownloadLink ||
    a?.translatedAudioDownloadLink ||
    a?.voiceWithBackgroundAudioDownloadLink ||
    a?.voiceAudioDownloadLink ||
    null
  );
}

async function pollUntilComplete(projectSeq: number, lang: string): Promise<void> {
  const deadline = Date.now() + MAX_POLL_MS;
  let delay = POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    const p = await getProgress(projectSeq);
    if (p.hasFailed || p.progressReason === "Failed") {
      throw new Error(`Perso dubbing failed (${lang}): ${p.progressReason ?? "unknown"}`);
    }
    if (p.progressReason === "Completed") return;
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), MAX_POLL_INTERVAL_MS);
  }
  throw new Error(`dubbing timed out (${lang})`);
}

async function waitForDubReadiness(projectSeq: number): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await getDownloadInfo(projectSeq);
    if (info.hasTranslateAudio || info.hasTranslatedVoice) return;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error("translated audio never became ready");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
