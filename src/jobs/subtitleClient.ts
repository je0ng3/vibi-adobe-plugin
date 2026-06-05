import { BFF_BASE_URL } from "../config";
import { loadToken } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { throwIfInsufficient } from "./creditClient";
import { newIdempotencyKey } from "./idempotencyKey";
import type { ScriptDraft } from "../types/job";

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 300;

async function authHeader(): Promise<Record<string, string>> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in");
  return { Authorization: `Bearer ${token.accessToken}` };
}

interface SubtitleStatus {
  status: "queued" | "processing" | "ready" | "failed";
  progress: number;
  progressReason: string | null;
  srtByLang: Record<string, string> | null;
  error: string | null;
}

export async function runSubtitle(
  script: ScriptDraft,
  targetLanguages: string[],
  onProgress?: (progress: number, reason: string | null) => void,
): Promise<Record<string, string>> {
  const startRes = await fetch(`${BFF_BASE_URL}/api/v2/subtitle`, {
    method: "POST",
    headers: {
      ...(await authHeader()),
      "Content-Type": "application/json",
      "Idempotency-Key": newIdempotencyKey(),
    },
    body: JSON.stringify({ script, targetLanguages }),
  });
  await throwIfInsufficient(startRes);
  if (!startRes.ok) throw new Error(`subtitle start failed: ${check401(startRes.status)}`);
  const { jobId } = (await startRes.json()) as { jobId: string };

  for (let i = 0; i < MAX_POLLS; i++) {
    const res = await fetch(`${BFF_BASE_URL}/api/v2/subtitle/${jobId}`, {
      headers: await authHeader(),
    });
    if (!res.ok) throw new Error(`subtitle poll failed: ${check401(res.status)}`);
    const st = (await res.json()) as SubtitleStatus;
    onProgress?.(st.progress, st.progressReason);
    if (st.status === "ready" && st.srtByLang) return st.srtByLang;
    if (st.status === "failed") throw new Error(st.error ?? "Subtitle failed");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Subtitle timed out");
}
