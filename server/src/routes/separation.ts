import { Hono } from "hono";
import { currentUser, requireAuth } from "../auth/middleware.js";
import { createJob, getJob } from "../jobs/jobStore.js";
import { runSeparationJob, type SeparationResult } from "../jobs/separationJob.js";
import { assembleDraft } from "../jobs/transcriptJob.js";
import { getFullAudioSeparationScript } from "../perso/persoClient.js";
import { ObjectKey, respondStem } from "./downloadResponder.js";
import { creditsForDuration, deduct, getBalance } from "../credit/creditStore.js";
import { ACCEPTED_AUDIO_LABEL, isAcceptedAudioName } from "../util/audioFormat.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";

export const separationRoute = new Hono();

const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200 MB — keep in sync with src/config.ts

// After requireAuth so it keys on the user (c.get("user")), not a shared NAT IP.
const separateLimiter = rateLimit({ windowMs: 60_000, max: 10 });

separationRoute.post("/api/v2/separate", uploadLimit(MAX_AUDIO_BYTES), requireAuth, separateLimiter, async (c) => {
  const user = currentUser(c);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (e) {
    console.error("[separate] formData parse failed", {
      contentType: c.req.header("Content-Type"),
      error: e instanceof Error ? e.message : String(e),
    });
    return c.json({ error: "bad_multipart" }, 400);
  }
  const file = form.get("audio");
  console.log("[separate] received", {
    contentType: c.req.header("Content-Type"),
    keys: [...form.keys()],
    audioType: typeof file,
    audioName: file && typeof file !== "string" ? file.name : null,
    audioSize: file && typeof file !== "string" ? file.size : null,
  });
  if (!file || typeof file === "string") {
    return c.json({ error: "audio_required" }, 400);
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return c.json({ error: "file_too_large", maxBytes: MAX_AUDIO_BYTES }, 413);
  }
  if (!isAcceptedAudioName(file.name)) {
    return c.json({ error: "unsupported_format", accepted: ACCEPTED_AUDIO_LABEL }, 415);
  }
  // Stable per-submit key (sent by the client) makes the charge + job creation idempotent,
  // so a transport-level retry of this POST can't double-charge or spawn a duplicate job.
  const idemKey = c.req.header("Idempotency-Key") || undefined;
  const cost = creditsForDuration(Number(form.get("durationMs")) || 0);
  if (!(await deduct(user.sub, cost, "separation", idemKey))) {
    return c.json({ error: "insufficient_credits", required: cost, balance: await getBalance(user.sub) }, 402);
  }
  const bytes = await file.arrayBuffer();
  const { job, created } = await createJob("separation", user.sub, idemKey);
  // Only start the work on first creation; a retry returns the in-flight job's id.
  // Refund the deducted credits if the job fails (see runSeparationJob).
  if (created) void runSeparationJob(job.id, bytes, file.name || "audio.wav", { ownerSub: user.sub, cost });
  return c.json({ jobId: job.id });
});

separationRoute.get("/api/v2/separate/:jobId", requireAuth, async (c) => {
  const user = currentUser(c);
  const job = await getJob(c.req.param("jobId") ?? "");
  if (!job || job.kind !== "separation") return c.json({ error: "not_found" }, 404);
  if (job.ownerSub !== user.sub) return c.json({ error: "forbidden" }, 403);
  const result = job.result as SeparationResult | undefined;
  return c.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    progressReason: job.progressReason ?? null,
    stems: result?.stems ?? [],
    error: job.error ?? null,
  });
});

// The diarized script the separation already produced — fetched on demand for "Check script".
// No new STT job: reads it straight off the separation's Perso projectSeq.
separationRoute.get("/api/v2/separate/:jobId/script", requireAuth, async (c) => {
  const user = currentUser(c);
  const job = await getJob(c.req.param("jobId") ?? "");
  if (!job || job.kind !== "separation") return c.json({ error: "not_found" }, 404);
  if (job.ownerSub !== user.sub) return c.json({ error: "forbidden" }, 403);
  const result = job.result as SeparationResult | undefined;
  if (job.status !== "ready" || result?.projectSeq == null) return c.json({ error: "not_ready" }, 409);
  try {
    const page = await getFullAudioSeparationScript(result.projectSeq);
    return c.json(assembleDraft(page.sentences, page.speakers));
  } catch (e) {
    console.error("[separate] script fetch failed", e);
    return c.json({ error: "script_failed" }, 502);
  }
});

separationRoute.get("/api/v2/separate/:jobId/stem/:stemId", requireAuth, async (c) => {
  const user = currentUser(c);
  const jobId = c.req.param("jobId") ?? "";
  const stemId = c.req.param("stemId") ?? "";
  const job = await getJob(jobId);
  if (!job || job.kind !== "separation") return c.json({ error: "not_found" }, 404);
  if (job.ownerSub !== user.sub) return c.json({ error: "forbidden" }, 403);
  if (job.status !== "ready") return c.json({ error: "not_ready" }, 409);
  return respondStem(c, {
    jobId,
    stemId,
    objectKey: ObjectKey.separationStem(jobId, stemId),
    contentType: "audio/wav",
    downloadFilename: `${stemId}.wav`,
    notFoundError: "stem_not_found",
  });
});
