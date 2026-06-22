import { Hono } from "hono";
import type { Context, Next } from "hono";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { requireAuth } from "../auth/middleware.js";
import { ACCEPTED_AUDIO_LABEL, isAcceptedAudioName } from "../util/audioFormat.js";
import { computePeaksFromPath } from "../util/peaks.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";

export const peaksRoute = new Hono();

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const peaksLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// Bound how many peaks computations run at once. Each holds the (up to 200MB) multipart body in
// RAM while ffmpeg decodes, so a burst of concurrent calls would OOM the 1GB e2-micro. Reject
// over-cap requests with 503 rather than queueing — queueing would pin those large bodies in RAM.
const MAX_CONCURRENT_PEAKS = Math.max(1, Number(process.env.MAX_CONCURRENT_PEAKS) || 2);
let peaksInFlight = 0;

async function peaksGate(c: Context, next: Next) {
  if (peaksInFlight >= MAX_CONCURRENT_PEAKS) {
    c.header("Retry-After", "5");
    return c.json({ error: "server_busy", retryAfterMs: 5000 }, 503);
  }
  peaksInFlight++;
  try {
    await next();
  } finally {
    peaksInFlight--;
  }
}

// Waveform peaks for the input preview. No credit charge — it's just an overview the UXP
// panel can't compute itself for mp3/m4a.
peaksRoute.post("/api/v2/peaks", uploadLimit(MAX_AUDIO_BYTES), requireAuth, peaksLimiter, peaksGate, async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "bad_multipart" }, 400);
  }
  const file = form.get("audio");
  if (!file || typeof file === "string") return c.json({ error: "audio_required" }, 400);
  if (file.size > MAX_AUDIO_BYTES) return c.json({ error: "file_too_large" }, 413);
  if (!isAcceptedAudioName(file.name)) {
    return c.json({ error: "unsupported_format", accepted: ACCEPTED_AUDIO_LABEL }, 415);
  }
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  // Stream the upload straight to a temp file rather than materializing file.arrayBuffer() — that
  // would add a second full-size (up to 200MB) copy in RAM on top of the parsed multipart body.
  const dir = await mkdtemp(join(tmpdir(), "vibi-peaks-"));
  const inputPath = join(dir, `in.${ext || "bin"}`);
  try {
    await pipeline(Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(inputPath));
    const result = await computePeaksFromPath(inputPath);
    return c.json(result);
  } catch (e) {
    console.error("[peaks] failed", e);
    return c.json({ error: "peaks_failed" }, 500);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
