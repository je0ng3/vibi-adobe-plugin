import { BFF_BASE_URL } from "../config";
import { loadToken } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { throwIfInsufficient } from "./creditClient";
import { newIdempotencyKey } from "./idempotencyKey";
import { buildMultipart } from "./multipart";
import { diag } from "../diag";
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

async function startSeparation(
  bytes: ArrayBuffer,
  fileName: string,
  durationMs: number,
  projectId: string | null,
): Promise<string> {
  const { body, contentType } = buildMultipart(
    { durationMs: String(durationMs), projectId: projectId ?? "" },
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

export async function fetchStem(jobId: string, stemId: string): Promise<ArrayBuffer> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/separate/${jobId}/stem/${stemId}`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`stem fetch failed: ${check401(res.status)}`);
  // R2 mode: server returns { url } with a presigned R2 URL instead of the bytes. Fetch it
  // directly WITHOUT the auth header — the presigned URL self-authenticates (SigV4 in the
  // query), and R2 rejects a request that also carries a Bearer header. Streaming fallback
  // (no R2 configured) returns the audio bytes inline, so branch on content-type.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const { url } = (await res.json()) as { url: string };
    const r2 = await fetch(url);
    if (!r2.ok) throw new Error(`stem fetch (r2) failed: ${r2.status}`);
    return r2.arrayBuffer();
  }
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
  projectId: string | null,
  onProgress?: (progress: number, reason: string | null) => void,
): Promise<SeparationOutcome> {
  diag(`separate: POST start (${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB)`);
  const jobId = await startSeparation(bytes, fileName, durationMs, projectId);
  diag(`separate: jobId=${jobId}`);
  for (let i = 0; i < MAX_POLLS; i++) {
    const st = await pollSeparation(jobId);
    onProgress?.(st.progress, st.progressReason);
    if (i === 0 || st.status === "ready" || st.status === "failed") {
      diag(`poll #${i}: ${st.status} ${st.progress}% stems=${st.stems?.length ?? 0}`);
    }
    if (st.status === "ready") {
      diag(`ready: fetching ${st.stems.length} stem(s)`);
      const stems = await Promise.all(
        st.stems.map(async (m) => {
          const b = await fetchStem(jobId, m.stemId);
          diag(`stem ${m.stemId}: ${(b.byteLength / 1024).toFixed(0)}KB`);
          return { stemId: m.stemId, label: m.label, bytes: b };
        }),
      );
      diag(`runSeparation done: ${stems.length} stem(s)`);
      return { stems, jobId };
    }
    if (st.status === "failed") throw new Error(st.error ?? "Separation failed");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Separation timed out");
}

// One saved separation as returned by the history list (no stem bytes — fetched on demand).
export interface SavedSeparation {
  jobId: string;
  fileName: string;
  byteLength: number;
  durationSec: number;
  createdAt: number;
  hasScript: boolean;
  stems: StemMeta[];
}

interface SavedSeparationWire {
  jobId: string;
  fileName: string | null;
  byteLength: number | null;
  durationMs: number | null;
  createdAt: number;
  hasScript: boolean;
  stems: StemMeta[];
}

// List the signed-in user's saved separations for a project, newest first. Used on sign-in /
// panel open to rebuild the result cards (the server is the source of truth across devices).
export async function listSeparations(projectId: string | null): Promise<SavedSeparation[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await fetch(`${BFF_BASE_URL}/api/v2/separations${qs}`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`history list failed: ${check401(res.status)}`);
  const data = (await res.json()) as { separations: SavedSeparationWire[] };
  return (data.separations ?? []).map((s) => ({
    jobId: s.jobId,
    fileName: s.fileName ?? "audio",
    byteLength: s.byteLength ?? 0,
    durationSec: (s.durationMs ?? 0) / 1000,
    createdAt: s.createdAt,
    hasScript: s.hasScript,
    stems: s.stems ?? [],
  }));
}

// Permanently delete a saved separation (row + stems on disk and R2). Idempotent server-side.
export async function deleteSeparation(jobId: string): Promise<void> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/separate/${jobId}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok && res.status !== 204) throw new Error(`history delete failed: ${check401(res.status)}`);
}

// Fetch the diarized script the separation already produced (fast — no separate STT job).
export async function fetchSeparationScript(jobId: string): Promise<ScriptDraft> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/separate/${jobId}/script`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`script fetch failed: ${check401(res.status)}`);
  return (await res.json()) as ScriptDraft;
}
