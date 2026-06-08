import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { mixAudio, type MixInput } from "../util/mix.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { uploadLimit } from "../middleware/uploadLimit.js";

export const mixRoute = new Hono();

const MAX_TOTAL_BYTES = 400 * 1024 * 1024; // generous: several stems
// Cap input count: each becomes an amix input in the filter graph, so many tiny files would
// build a pathological filter_complex (ffmpeg memory/CPU blowup) within the byte budget.
const MAX_INPUTS = 16;
const mixLimiter = rateLimit({ windowMs: 60_000, max: 20 });

interface UploadFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

// Mix selected stems server-side (ffmpeg). No credit charge — it's a local transform of
// already-generated stems. Body: multipart with repeated "audio" files + a "volumes" CSV.
mixRoute.post("/api/v2/mix", uploadLimit(MAX_TOTAL_BYTES), requireAuth, mixLimiter, async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "bad_multipart" }, 400);
  }
  const files = form.getAll("audio").filter((f) => typeof f !== "string") as unknown as UploadFile[];
  if (files.length === 0) return c.json({ error: "audio_required" }, 400);
  if (files.length > MAX_INPUTS) return c.json({ error: "too_many_inputs", max: MAX_INPUTS }, 400);

  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_BYTES) return c.json({ error: "file_too_large" }, 413);

  const volumes = String(form.get("volumes") ?? "")
    .split(",")
    .map((v) => Number(v.trim()));

  try {
    const inputs: MixInput[] = await Promise.all(
      files.map(async (f, i) => ({
        bytes: await f.arrayBuffer(),
        volume: Number.isFinite(volumes[i]) ? volumes[i] : 100,
      })),
    );
    const wav = await mixAudio(inputs);
    // Explicit Content-Length (non-chunked) + audio excluded from Caddy gzip — UXP's fetch
    // stalls forever on a chunked/gzip'd binary body. See routes/separation.ts + Caddyfile.
    const len = (wav as ArrayBuffer | Uint8Array).byteLength;
    return new Response(wav, {
      headers: { "Content-Type": "audio/wav", "Content-Length": String(len) },
    });
  } catch (e) {
    console.error("[mix] failed", e);
    return c.json({ error: "mix_failed" }, 500);
  }
});
