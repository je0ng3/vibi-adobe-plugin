import { BFF_BASE_URL } from "../config";
import { loadToken } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { newIdempotencyKey } from "./idempotencyKey";
import { buildMultipart } from "./multipart";
import type { ScriptDraft } from "../types/job";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 200;

async function authHeader(): Promise<Record<string, string>> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in");
  return { Authorization: `Bearer ${token.accessToken}` };
}

export async function startTranscript(bytes: ArrayBuffer, fileName: string): Promise<string> {
  const { body, contentType } = buildMultipart({}, [{ field: "audio", fileName, bytes }]);
  const res = await fetch(`${BFF_BASE_URL}/api/v2/transcript`, {
    method: "POST",
    headers: {
      ...(await authHeader()),
      "Idempotency-Key": newIdempotencyKey(),
      "Content-Type": contentType,
    },
    body,
  });
  if (!res.ok) throw new Error(`transcript start failed: ${check401(res.status)}`);
  const data = (await res.json()) as { jobId: string };
  return data.jobId;
}

interface TranscriptStatus {
  status: "queued" | "processing" | "ready" | "failed";
  progress: number;
  progressReason: string | null;
  script: ScriptDraft | null;
  error: string | null;
}

export async function pollTranscript(jobId: string): Promise<TranscriptStatus> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/transcript/${jobId}`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`transcript poll failed: ${check401(res.status)}`);
  return (await res.json()) as TranscriptStatus;
}

export async function runTranscript(
  bytes: ArrayBuffer,
  fileName: string,
  onProgress?: (progress: number, reason: string | null) => void,
): Promise<ScriptDraft> {
  const jobId = await startTranscript(bytes, fileName);
  for (let i = 0; i < MAX_POLLS; i++) {
    const st = await pollTranscript(jobId);
    onProgress?.(st.progress, st.progressReason);
    if (st.status === "ready" && st.script) return st.script;
    if (st.status === "failed") throw new Error(st.error ?? "Transcript failed");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Transcript timed out");
}
