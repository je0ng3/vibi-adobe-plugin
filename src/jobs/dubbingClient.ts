import { BFF_BASE_URL } from "../config";
import { loadToken } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { throwIfInsufficient } from "./creditClient";
import { newIdempotencyKey } from "./idempotencyKey";
import { buildMultipart } from "./multipart";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 600;

async function authHeader(): Promise<Record<string, string>> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in");
  return { Authorization: `Bearer ${token.accessToken}` };
}

export interface DubTrack {
  lang: string;
  bytes: ArrayBuffer;
}

interface DubStatus {
  status: "queued" | "processing" | "ready" | "failed";
  progress: number;
  progressReason: string | null;
  dubs: { lang: string }[];
  error: string | null;
}

async function fetchDubAudio(jobId: string, lang: string): Promise<ArrayBuffer> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/dub/${jobId}/audio/${lang}`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`dub audio fetch failed: ${check401(res.status)}`);
  return res.arrayBuffer();
}

export async function runDubbing(
  bytes: ArrayBuffer,
  fileName: string,
  sourceLanguage: string,
  targetLanguages: string[],
  numberOfSpeakers: number,
  durationMs: number,
  onProgress?: (progress: number, reason: string | null) => void,
): Promise<DubTrack[]> {
  const { body, contentType } = buildMultipart(
    {
      sourceLanguage,
      targetLanguages: targetLanguages.join(","),
      numberOfSpeakers: String(numberOfSpeakers),
      durationMs: String(durationMs),
    },
    [{ field: "audio", fileName, bytes }],
  );
  const startRes = await fetch(`${BFF_BASE_URL}/api/v2/dub`, {
    method: "POST",
    headers: {
      ...(await authHeader()),
      "Idempotency-Key": newIdempotencyKey(),
      "Content-Type": contentType,
    },
    body,
  });
  await throwIfInsufficient(startRes);
  if (!startRes.ok) throw new Error(`dub start failed: ${check401(startRes.status)}`);
  const { jobId } = (await startRes.json()) as { jobId: string };

  for (let i = 0; i < MAX_POLLS; i++) {
    const res = await fetch(`${BFF_BASE_URL}/api/v2/dub/${jobId}`, { headers: await authHeader() });
    if (!res.ok) throw new Error(`dub poll failed: ${check401(res.status)}`);
    const st = (await res.json()) as DubStatus;
    onProgress?.(st.progress, st.progressReason);
    if (st.status === "ready") {
      return Promise.all(
        st.dubs.map(async (d) => ({ lang: d.lang, bytes: await fetchDubAudio(jobId, d.lang) })),
      );
    }
    if (st.status === "failed") throw new Error(st.error ?? "Dubbing failed");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Dubbing timed out");
}
