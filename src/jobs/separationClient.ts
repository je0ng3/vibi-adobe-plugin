import { BFF_BASE_URL } from "../config";
import { loadToken } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { throwIfInsufficient } from "./creditClient";
import { newIdempotencyKey } from "./idempotencyKey";
import { buildMultipart } from "./multipart";
import type { ScriptDraft } from "../types/job";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 600;

async function authHeader(): Promise<Record<string, string>> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in");
  return { Authorization: `Bearer ${token.accessToken}` };
}

export interface SeparatedStem {
  stemId: string;
  label: string;
  bytes: ArrayBuffer;
}

interface StemMeta {
  stemId: string;
  label: string;
}

interface SeparationStatus {
  status: "queued" | "processing" | "ready" | "failed";
  progress: number;
  progressReason: string | null;
  stems: StemMeta[];
  error: string | null;
}

async function startSeparation(bytes: ArrayBuffer, fileName: string, durationMs: number): Promise<string> {
  const { body, contentType } = buildMultipart(
    { durationMs: String(durationMs) },
    [{ field: "audio", fileName, bytes }],
  );
  console.log("[separate] POST", {
    url: `${BFF_BASE_URL}/api/v2/separate`,
    contentType,
    bodyBytes: body.byteLength,
    fileName,
    durationMs,
  });
  const res = await fetch(`${BFF_BASE_URL}/api/v2/separate`, {
    method: "POST",
    headers: {
      ...(await authHeader()),
      "Idempotency-Key": newIdempotencyKey(),
      "Content-Type": contentType,
    },
    body,
  });
  await throwIfInsufficient(res);
  if (!res.ok) {
    check401(res.status);
    const detail = await res.text().catch(() => "");
    console.error("[separate] start failed", res.status, detail);
    throw new Error(`separation start failed: ${res.status} ${detail}`);
  }
  const data = (await res.json()) as { jobId: string };
  return data.jobId;
}

async function pollSeparation(jobId: string): Promise<SeparationStatus> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/separate/${jobId}`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`separation poll failed: ${check401(res.status)}`);
  return (await res.json()) as SeparationStatus;
}

async function fetchStem(jobId: string, stemId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/separate/${jobId}/stem/${stemId}`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`stem fetch failed: ${check401(res.status)}`);
  return res.arrayBuffer();
}

export interface SeparationOutcome {
  stems: SeparatedStem[];
  jobId: string; // kept so the panel can later fetch the separation's diarized script
}

export async function runSeparation(
  bytes: ArrayBuffer,
  fileName: string,
  durationMs: number,
  onProgress?: (progress: number, reason: string | null) => void,
): Promise<SeparationOutcome> {
  const jobId = await startSeparation(bytes, fileName, durationMs);
  for (let i = 0; i < MAX_POLLS; i++) {
    const st = await pollSeparation(jobId);
    onProgress?.(st.progress, st.progressReason);
    if (st.status === "ready") {
      const stems = await Promise.all(
        st.stems.map(async (m) => ({
          stemId: m.stemId,
          label: m.label,
          bytes: await fetchStem(jobId, m.stemId),
        })),
      );
      return { stems, jobId };
    }
    if (st.status === "failed") throw new Error(st.error ?? "Separation failed");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Separation timed out");
}

// Fetch the diarized script the separation already produced (fast — no separate STT job).
export async function fetchSeparationScript(jobId: string): Promise<ScriptDraft> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/separate/${jobId}/script`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`script fetch failed: ${check401(res.status)}`);
  return (await res.json()) as ScriptDraft;
}
