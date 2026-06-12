import { Hono } from "hono";
import { currentUser, requireAuth } from "../auth/middleware.js";
import { createJob, getJob, listReadySeparations, deleteJob, updateJob } from "../jobs/jobStore.js";
import { purgeSeparationArtifacts } from "../jobs/artifacts.js";
import { runSeparationJob, type SeparationResult } from "../jobs/separationJob.js";
import { runQueued, isQueueFull } from "../jobs/jobQueue.js";
import { assembleDraft } from "../jobs/transcriptJob.js";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFullAudioSeparationScript } from "../perso/persoClient.js";
import { ObjectKey, respondStem } from "./downloadResponder.js";
import { creditsForDuration, deduct, getBalance, refund } from "../credit/creditStore.js";
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
  const durationMs = Number(form.get("durationMs")) || 0;
  // Which Premiere project this belongs to — scopes the saved-separation history list. The
  // client sends a stable key (guid/path/name) or "default"; treat blank as null.
  const projectIdRaw = form.get("projectId");
  const projectId = typeof projectIdRaw === "string" && projectIdRaw.trim() ? projectIdRaw.trim() : null;
  const cost = creditsForDuration(durationMs);
  // Flood guard: if the wait line is already at capacity, reject up-front (before charging)
  // rather than let the backlog grow unbounded and OOM the box. Client can retry shortly.
  if (isQueueFull()) {
    return c.json({ error: "server_busy", retryAfterMs: 30_000 }, 503);
  }
  if (!(await deduct(user.sub, cost, "separation", idemKey))) {
    return c.json({ error: "insufficient_credits", required: cost, balance: await getBalance(user.sub) }, 402);
  }
  // Past the deduct the user is charged. If setup throws before the runner's own catch can fire
  // (createJob, or spooling the upload), refund the up-front charge so a failed setup never leaves
  // the user out of pocket. cost is persisted on the row so a restart mid-job can also refund.
  let creation;
  try {
    creation = await createJob("separation", user.sub, {
      idempotencyKey: idemKey,
      projectId,
      fileName: file.name || "audio.wav",
      byteLength: file.size,
      durationMs,
      cost,
    });
  } catch (e) {
    // No job row yet → refund on a setup-scoped ref (distinct from the runner's refund:<jobId>,
    // so the two can't collide). Stable across client retries via the idempotency key.
    await refund(user.sub, cost, `refund:setup:${idemKey ?? user.sub}:${cost}`).catch((err) =>
      console.error("[separate] setup refund (createJob) failed:", err),
    );
    throw e;
  }
  const { job, created } = creation;
  // Only start the work on first creation; a retry returns the in-flight job's id.
  if (created) {
    // Spool the upload to a temp file and drop the in-memory buffer immediately, so a job
    // WAITING for a concurrency slot holds only a path — not its ≤200MB buffer. Without this,
    // a burst of queued jobs would each pin 200MB and OOM the 1GB instance.
    const tmpPath = join(tmpdir(), `vibi-sep-${job.id}.bin`);
    try {
      await writeFile(tmpPath, Buffer.from(await file.arrayBuffer()));
    } catch (e) {
      // Spool failed before the job could run → it'd otherwise sit 'queued' forever. Refund and
      // mark it failed. refund:<jobId> matches the runner's ref (idempotent, no double-refund).
      await refund(user.sub, cost, `refund:${job.id}`).catch((err) =>
        console.error("[separate] spool refund failed:", err),
      );
      await updateJob(job.id, { status: "failed", error: "upload spool failed" }).catch(() => {});
      throw e;
    }
    const fileName = file.name || "audio.wav";
    // runQueued caps concurrent runs (jobQueue.ts); excess jobs wait with their row "queued".
    void runQueued(async () => {
      try {
        const buf = await readFile(tmpPath);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        await runSeparationJob(job.id, ab, fileName, { ownerSub: user.sub, cost });
      } catch (e) {
        // A throw BEFORE runSeparationJob's own try (e.g. readFile) would otherwise strand the job
        // and skip its refund — and, as a detached `void` task, surface as an unhandled rejection.
        // Refund + fail here too; runSeparationJob swallows its own errors, so this never doubles up.
        console.error(`[separate] job ${job.id} runner setup failed:`, e);
        await refund(user.sub, cost, `refund:${job.id}`).catch(() => {});
        await updateJob(job.id, {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        }).catch(() => {});
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    });
  }
  return c.json({ jobId: job.id });
});

// A user's saved separations for the open Premiere project, newest first. The panel calls this
// on sign-in / open to rebuild the result cards (then fetches each stem on demand). `projectId`
// omitted → the "default" (no-project) bucket.
separationRoute.get("/api/v2/separations", requireAuth, async (c) => {
  const user = currentUser(c);
  const projectIdRaw = c.req.query("projectId");
  const projectId = projectIdRaw && projectIdRaw.trim() ? projectIdRaw.trim() : null;
  const separations = await listReadySeparations(user.sub, projectId);
  return c.json({ separations });
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

// Forget a saved separation: remove the row and purge its stems (disk + R2). The user removes
// a card explicitly, so this permanently deletes the (paid) result rather than just hiding it.
separationRoute.delete("/api/v2/separate/:jobId", requireAuth, async (c) => {
  const user = currentUser(c);
  const jobId = c.req.param("jobId") ?? "";
  const job = await getJob(jobId);
  // Already gone → 204 (idempotent). Someone else's job → 403, don't reveal existence further.
  if (!job || job.kind !== "separation") return c.body(null, 204);
  if (job.ownerSub !== user.sub) return c.json({ error: "forbidden" }, 403);
  await deleteJob(jobId, user.sub);
  await purgeSeparationArtifacts(jobId);
  return c.body(null, 204);
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
