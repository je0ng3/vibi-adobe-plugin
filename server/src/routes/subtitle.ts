import { Hono } from "hono";
import { currentUser, requireAuth } from "../auth/middleware.js";
import { createJob, getJob } from "../jobs/jobStore.js";
import { runSubtitleJob, type SubtitleResult } from "../jobs/subtitleJob.js";
import { creditsForDuration, deduct, getBalance } from "../credit/creditStore.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";
import type { ScriptDraft } from "../types/script.js";

export const subtitleRoute = new Hono();

// JSON body (a script + target languages), not a media upload — bound it small so a giant
// payload can't exhaust memory. Charges credits + rate-limited like the other paid jobs.
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const subtitleLimiter = rateLimit({ windowMs: 60_000, max: 10 });

subtitleRoute.post("/api/v2/subtitle", uploadLimit(MAX_JSON_BYTES), requireAuth, subtitleLimiter, async (c) => {
  const user = currentUser(c);
  const body = await c.req.json().catch(() => ({}));
  const script = body.script as ScriptDraft | undefined;
  const targetLanguages = Array.isArray(body.targetLanguages)
    ? (body.targetLanguages as string[])
    : [];
  if (!script || !Array.isArray(script.segments)) {
    return c.json({ error: "script_required" }, 400);
  }
  const durationMs = script.segments.reduce((max, s) => Math.max(max, s.endMs), 0);
  const idemKey = c.req.header("Idempotency-Key") || undefined;
  const cost = creditsForDuration(durationMs);
  if (!(await deduct(user.sub, cost, "subtitle", idemKey))) {
    return c.json({ error: "insufficient_credits", required: cost, balance: await getBalance(user.sub) }, 402);
  }
  const { job, created } = await createJob("subtitle", user.sub, idemKey);
  if (created) void runSubtitleJob(job.id, script, targetLanguages, { ownerSub: user.sub, cost });
  return c.json({ jobId: job.id });
});

subtitleRoute.get("/api/v2/subtitle/:jobId", requireAuth, async (c) => {
  const user = currentUser(c);
  const job = await getJob(c.req.param("jobId") ?? "");
  if (!job || job.kind !== "subtitle") return c.json({ error: "not_found" }, 404);
  if (job.ownerSub !== user.sub) return c.json({ error: "forbidden" }, 403);
  const result = job.result as SubtitleResult | undefined;
  return c.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    progressReason: job.progressReason ?? null,
    srtByLang: result?.srtByLang ?? null,
    error: job.error ?? null,
  });
});
