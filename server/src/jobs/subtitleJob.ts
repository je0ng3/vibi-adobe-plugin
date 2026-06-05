import { geminiTranslate } from "../gemini/geminiClient.js";
import { buildSrt } from "../util/srt.js";
import { updateJob } from "./jobStore.js";
import { refund, type BillingRef } from "../credit/creditStore.js";
import type { ScriptDraft } from "../types/script.js";

export interface SubtitleResult {
  srtByLang: Record<string, string>;
}

export async function runSubtitleJob(
  jobId: string,
  script: ScriptDraft,
  targetLanguages: string[],
  billing?: BillingRef,
): Promise<void> {
  try {
    await updateJob(jobId, { status: "processing", progress: 10, progressReason: "Building subtitles" });
    const srtByLang: Record<string, string> = { original: buildSrt(script.segments) };

    const total = targetLanguages.length;
    for (let i = 0; i < total; i++) {
      const lang = targetLanguages[i];
      await updateJob(jobId, {
        progress: Math.min(95, 20 + Math.round(((i + 1) / Math.max(1, total)) * 70)),
        progressReason: `Translating (${lang})`,
      });
      const translated = await geminiTranslate(
        script.segments.map((s) => s.text),
        lang,
      );
      const segs = script.segments.map((s, idx) => ({ ...s, text: translated[idx] ?? s.text }));
      srtByLang[lang] = buildSrt(segs);
    }

    await updateJob(jobId, {
      status: "ready",
      progress: 100,
      progressReason: "Done",
      result: { srtByLang } satisfies SubtitleResult,
    });
  } catch (e) {
    // Charged up-front by the route — refund on failure (idempotent via the ledger ref).
    if (billing) {
      await refund(billing.ownerSub, billing.cost, `refund:${jobId}`).catch((err) =>
        console.error("[subtitle] refund failed:", err),
      );
    }
    await updateJob(jobId, { status: "failed", error: e instanceof Error ? e.message : String(e) });
  }
}
