import { Hono } from "hono";
import { currentUser, requireAuth } from "../auth/middleware.js";
import { createJob, getJob } from "../jobs/jobStore.js";
import { runTranscriptJob } from "../jobs/transcriptJob.js";
import { creditsForDuration, deduct, getBalance } from "../credit/creditStore.js";
import { ACCEPTED_AUDIO_LABEL, isAcceptedAudioName } from "../util/audioFormat.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";
import type { ScriptDraft } from "../types/script.js";

export const transcriptRoute = new Hono();

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const transcriptLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// Charges credits + rate-limits like the other paid jobs: a transcript triggers a real Perso STT
// job (upstream cost), so it must not be a free, unbounded endpoint. Refunded on failure below.
transcriptRoute.post("/api/v2/transcript", uploadLimit(MAX_AUDIO_BYTES), requireAuth, transcriptLimiter, async (c) => {
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
  const idemKey = c.req.header("Idempotency-Key") || undefined;
  const cost = creditsForDuration(Number(form.get("durationMs")) || 0);
  if (!(await deduct(user.sub, cost, "transcript", idemKey))) {
    return c.json({ error: "insufficient_credits", required: cost, balance: await getBalance(user.sub) }, 402);
  }
  const bytes = await file.arrayBuffer();
  const { job, created } = await createJob("transcript", user.sub, idemKey);
  if (created) void runTranscriptJob(job.id, bytes, file.name || "audio.wav", { ownerSub: user.sub, cost });
  return c.json({ jobId: job.id });
});

transcriptRoute.get("/api/v2/transcript/:jobId", requireAuth, async (c) => {
  const user = currentUser(c);
  const job = await getJob(c.req.param("jobId") ?? "");
  if (!job || job.kind !== "transcript") return c.json({ error: "not_found" }, 404);
  if (job.ownerSub !== user.sub) return c.json({ error: "forbidden" }, 403);
  return c.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    progressReason: job.progressReason ?? null,
    script: (job.result as ScriptDraft | undefined) ?? null,
    error: job.error ?? null,
  });
});
