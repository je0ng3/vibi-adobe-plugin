import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { extractAudioFromBytes } from "../util/extractAudio.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";

export const extractRoute = new Hono();

const MAX_BYTES = 200 * 1024 * 1024; // video clips can be large; bound to protect memory/CPU
const extractLimiter = rateLimit({ windowMs: 60_000, max: 30 });

// Extract an UPLOADED media file's audio track to mp3 (ffmpeg). Body: multipart with one "media"
// file. No credit charge. The client uploads bytes (not a path) so the server never opens an
// attacker-controlled path/URL.
extractRoute.post("/api/v2/extract-audio", uploadLimit(MAX_BYTES), requireAuth, extractLimiter, async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "bad_multipart" }, 400);
  }
  const file = form.get("media");
  if (!file || typeof file === "string") return c.json({ error: "media_required" }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: "file_too_large", maxBytes: MAX_BYTES }, 413);
  try {
    const mp3 = await extractAudioFromBytes(await file.arrayBuffer());
    return new Response(mp3, { headers: { "Content-Type": "audio/mpeg" } });
  } catch (e) {
    console.error("[extract] failed", e);
    return c.json({ error: "extract_failed" }, 500);
  }
});
