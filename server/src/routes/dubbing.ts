import { Hono } from "hono";
import { currentUser, requireAuth } from "../auth/middleware.js";
import { createJob, getJob } from "../jobs/jobStore.js";
import { runDubbingJob, dubStemId, type DubResult } from "../jobs/dubbingJob.js";
import { ObjectKey, respondStem } from "./downloadResponder.js";
import { creditsForDuration, deduct, getBalance } from "../credit/creditStore.js";
import { ACCEPTED_AUDIO_LABEL, isAcceptedAudioName } from "../util/audioFormat.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";

export const dubbingRoute = new Hono();

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const dubLimiter = rateLimit({ windowMs: 60_000, max: 10 });

dubbingRoute.post("/api/v2/dub", uploadLimit(MAX_AUDIO_BYTES), requireAuth, dubLimiter, async (c) => {
  const user = currentUser(c);
  const form = await c.req.formData();
  const file = form.get("audio");
  if (!file || typeof file === "string") {
    return c.json({ error: "audio_required" }, 400);
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return c.json({ error: "file_too_large", maxBytes: MAX_AUDIO_BYTES }, 413);
  }
  if (!isAcceptedAudioName(file.name)) {
    return c.json({ error: "unsupported_format", accepted: ACCEPTED_AUDIO_LABEL }, 415);
  }
  const sourceLanguage = String(form.get("sourceLanguage") ?? "").trim();
  const targetLanguages = String(form.get("targetLanguages") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const numberOfSpeakers = Math.max(1, Number(form.get("numberOfSpeakers")) || 1);
  if (!sourceLanguage) return c.json({ error: "sourceLanguage_required" }, 400);
  if (targetLanguages.length === 0) return c.json({ error: "targetLanguages_required" }, 400);

  const idemKey = c.req.header("Idempotency-Key") || undefined;
  const cost = creditsForDuration(Number(form.get("durationMs")) || 0);
  if (!(await deduct(user.sub, cost, "dubbing", idemKey))) {
    return c.json({ error: "insufficient_credits", required: cost, balance: await getBalance(user.sub) }, 402);
  }
  const bytes = await file.arrayBuffer();
  const { job, created } = await createJob("dubbing", user.sub, idemKey);
  if (created) {
    void runDubbingJob(job.id, bytes, file.name || "audio.wav", sourceLanguage, targetLanguages, numberOfSpeakers, {
      ownerSub: user.sub,
      cost,
    });
  }
  return c.json({ jobId: job.id });
});

dubbingRoute.get("/api/v2/dub/:jobId", requireAuth, async (c) => {
  const user = currentUser(c);
  const job = await getJob(c.req.param("jobId") ?? "");
  if (!job || job.kind !== "dubbing") return c.json({ error: "not_found" }, 404);
  if (job.ownerSub !== user.sub) return c.json({ error: "forbidden" }, 403);
  const result = job.result as DubResult | undefined;
  return c.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    progressReason: job.progressReason ?? null,
    dubs: result?.dubs ?? [],
    error: job.error ?? null,
  });
});

dubbingRoute.get("/api/v2/dub/:jobId/audio/:lang", requireAuth, async (c) => {
  const user = currentUser(c);
  const jobId = c.req.param("jobId") ?? "";
  const lang = c.req.param("lang") ?? "";
  const job = await getJob(jobId);
  if (!job || job.kind !== "dubbing") return c.json({ error: "not_found" }, 404);
  if (job.ownerSub !== user.sub) return c.json({ error: "forbidden" }, 403);
  const stemId = dubStemId(lang);
  return respondStem(c, {
    jobId,
    stemId,
    objectKey: ObjectKey.dubAudio(jobId, stemId),
    contentType: "audio/mpeg",
    downloadFilename: `dub-${lang}.mp3`,
    notFoundError: "audio_not_found",
  });
});
