import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { segmentSpeaker, type TimeRange } from "../util/segment.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";

export const segmentRoute = new Hono();

const MAX_BYTES = 200 * 1024 * 1024;
// Cap range count: each range becomes a `between(...)` clause in the ffmpeg filter string, so an
// unbounded array would build a pathologically long -af arg (ffmpeg slowdown / arg-length limit).
const MAX_RANGES = 1000;
const segmentLimiter = rateLimit({ windowMs: 60_000, max: 60 });

interface UploadFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

// Isolate one speaker from the original audio by time ranges (ffmpeg). No credit charge — it's a
// local transform driven by the (already-paid) transcript. Body: multipart with one "audio" file
// + a "ranges" JSON field ([{startMs,endMs}, ...]). Returns one WAV (full length, muted outside
// the ranges). Called once per speaker by the script-based editable-separation flow.
segmentRoute.post("/api/v2/segment", uploadLimit(MAX_BYTES), requireAuth, segmentLimiter, async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "bad_multipart" }, 400);
  }

  const file = form.getAll("audio").filter((f) => typeof f !== "string")[0] as unknown as UploadFile | undefined;
  if (!file) return c.json({ error: "audio_required" }, 400);
  if (file.size > MAX_BYTES) return c.json({ error: "file_too_large" }, 413);

  let ranges: TimeRange[];
  try {
    const parsed = JSON.parse(String(form.get("ranges") ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("ranges must be an array");
    ranges = parsed
      .map((r) => ({ startMs: Number(r?.startMs), endMs: Number(r?.endMs) }))
      .filter((r) => Number.isFinite(r.startMs) && Number.isFinite(r.endMs));
  } catch {
    return c.json({ error: "bad_ranges" }, 400);
  }
  if (ranges.length > MAX_RANGES) return c.json({ error: "too_many_ranges", max: MAX_RANGES }, 400);

  try {
    const wav = await segmentSpeaker(await file.arrayBuffer(), ranges);
    return new Response(wav, { headers: { "Content-Type": "audio/wav" } });
  } catch (e) {
    console.error("[segment] failed", e);
    return c.json({ error: "segment_failed" }, 500);
  }
});
