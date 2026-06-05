import { getFullSttScript, getProgress, submitStt, uploadAudio } from "../perso/persoClient.js";
import { updateJob } from "./jobStore.js";
import { refund, type BillingRef } from "../credit/creditStore.js";
import type { ScriptDraft, Speaker, TranscriptSegment } from "../types/script.js";
import type { PersoScriptSentence, PersoScriptSpeaker } from "../perso/persoTypes.js";

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 15000;
const MAX_POLL_MS = 5 * 60 * 1000;

export async function runTranscriptJob(
  jobId: string,
  audio: ArrayBuffer,
  fileName: string,
  billing?: BillingRef,
): Promise<void> {
  try {
    await updateJob(jobId, { status: "processing", progress: 5, progressReason: "Uploading" });
    const media = await uploadAudio(audio, fileName);

    await updateJob(jobId, { progress: 15, progressReason: "Submitting" });
    const projectSeq = await submitStt(media.seq, fileName);

    await updateJob(jobId, { progress: 25, progressReason: "Transcribing" });
    const start = Date.now();
    let delay = POLL_INTERVAL_MS;
    while (Date.now() - start < MAX_POLL_MS) {
      const p = await getProgress(projectSeq);
      if (p.hasFailed) throw new Error(p.progressReason ?? "Perso STT failed");
      await updateJob(jobId, {
        progress: Math.min(95, 25 + Math.round((p.progress ?? 0) * 0.7)),
        progressReason: p.progressReason ?? "Transcribing",
      });
      if ((p.progress ?? 0) >= 100) break;
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), MAX_POLL_INTERVAL_MS);
    }

    const page = await getFullSttScript(projectSeq);
    const script = assembleDraft(page.sentences, page.speakers);
    await updateJob(jobId, { status: "ready", progress: 100, progressReason: "Done", result: script });
  } catch (e) {
    // Refund the up-front charge so a failed STT doesn't bill the user. Idempotent via the ledger ref.
    if (billing) {
      await refund(billing.ownerSub, billing.cost, `refund:${jobId}`).catch((err) =>
        console.error("[transcript] refund failed:", err),
      );
    }
    await updateJob(jobId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
}

export function assembleDraft(
  sentences: PersoScriptSentence[],
  speakers: PersoScriptSpeaker[],
): ScriptDraft {
  const indices = new Set<number>();
  for (const sp of speakers) indices.add(sp.speakerOrderIndex);
  for (const s of sentences) indices.add(s.speakerOrderIndex);
  if (indices.size === 0) indices.add(1);

  const speakerList: Speaker[] = [...indices]
    .sort((a, b) => a - b)
    .map((index) => ({ index, label: `Speaker ${index}` }));

  const segments: TranscriptSegment[] = sentences.map((s, idx) => ({
    id: `seg-${s.seq ?? idx + 1}`,
    speakerIndex: s.speakerOrderIndex,
    text: s.originalText ?? "",
    startMs: s.offsetMs ?? 0,
    endMs: (s.offsetMs ?? 0) + (s.durationMs ?? 0),
  }));

  return { speakers: speakerList, segments };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
