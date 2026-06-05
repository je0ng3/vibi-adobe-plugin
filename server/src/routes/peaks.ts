import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { ACCEPTED_AUDIO_LABEL, isAcceptedAudioName } from "../util/audioFormat.js";
import { computePeaks } from "../util/peaks.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";

export const peaksRoute = new Hono();

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const peaksLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// Waveform peaks for the input preview. No credit charge — it's just an overview the UXP
// panel can't compute itself for mp3/m4a.
peaksRoute.post("/api/v2/peaks", uploadLimit(MAX_AUDIO_BYTES), requireAuth, peaksLimiter, async (c) => {
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
  try {
    const bytes = await file.arrayBuffer();
    const result = await computePeaks(bytes, ext);
    return c.json(result);
  } catch (e) {
    console.error("[peaks] failed", e);
    return c.json({ error: "peaks_failed" }, 500);
  }
});
