import { BFF_BASE_URL } from "../config";
import { authHeader } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { throwIfInsufficient } from "./creditClient";
import { newIdempotencyKey } from "./idempotencyKey";
import { buildMultipart } from "./multipart";
import { fetchWithTimeout, readJson, TRANSFER_TIMEOUT_MS } from "./http";
import { formatMb } from "../audio/format";
import { diag } from "../diag";
import type { ScriptDraft } from "../types/job";
import { defaultSpeakerLabel, isAutoSpeakerLabel } from "../types/job";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 600;

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
  // BFF 계약: 파일 필드 "file" + "spec" JSON(SeparationSpec). projectId/fileName/byteLength 는
  // history 카드 메타로 spec 에 실어 보낸다(모바일은 omit). durationMs 는 BFF 가 업로드 파일을
  // ffprobe 로 직접 측정하므로 보내지 않는다(클라 추정보다 정확).
  const spec = JSON.stringify({
    projectId: projectId ?? null,
    fileName,
    byteLength: bytes.byteLength,
  });
  const { body, contentType } = buildMultipart(
    { spec },
    [{ field: "file", fileName, bytes }],
  );
  console.log("[separate] POST", {
    url: `${BFF_BASE_URL}/api/v2/separate`,
    contentType,
    bodyBytes: body.byteLength,
    fileName,
    durationMs,
  });
  const res = await fetchWithTimeout(
    `${BFF_BASE_URL}/api/v2/separate`,
    {
      method: "POST",
      headers: {
        ...(await authHeader()),
        "Idempotency-Key": newIdempotencyKey(),
        "Content-Type": contentType,
      },
      body,
    },
    TRANSFER_TIMEOUT_MS,
  );
  await throwIfInsufficient(res);
  if (!res.ok) {
    check401(res.status);
    const detail = await res.text().catch(() => "");
    console.error("[separate] start failed", res.status, detail);
    throw new Error(`separation start failed: ${res.status} ${detail}`);
  }
  const data = await readJson<{ jobId: string }>(res, "separation start");
  return data.jobId;
}

async function pollSeparation(jobId: string): Promise<SeparationStatus> {
  const res = await fetchWithTimeout(`${BFF_BASE_URL}/api/v2/separate/${jobId}`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`separation poll failed: ${check401(res.status)}`);
  const data = await readJson<SeparationStatus>(res, "separation poll");
  // BFF 는 status 를 대문자(QUEUED/PROCESSING/READY/FAILED)로 보낸다. 이 클라는 소문자
  // (queued/processing/ready/failed)를 기대하므로 정규화 — 안 하면 "READY" 를 "ready" 로
  // 못 봐 100%에서 멈춘다(모바일은 대문자 그대로 처리하므로 BFF 는 안 바꿈).
  return { ...data, status: String(data.status ?? "").toLowerCase() as SeparationStatus["status"] };
}

export async function fetchStem(jobId: string, stemId: string): Promise<ArrayBuffer> {
  // The job is already done server-side and the bytes are durable (R2/disk); a transient blip
  // shouldn't lose a stem the user paid for. Retry a couple of times before giving up — the
  // caller (live result OR history restore) then has the bytes, or a clear failure.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
    try {
      return await fetchStemOnce(jobId, stemId);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchStemOnce(jobId: string, stemId: string): Promise<ArrayBuffer> {
  const res = await fetchWithTimeout(
    `${BFF_BASE_URL}/api/v2/separate/${jobId}/stem/${stemId}`,
    { headers: await authHeader() },
    TRANSFER_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`stem fetch failed: ${check401(res.status)}`);
  // R2 mode: server returns { url } with a presigned R2 URL instead of the bytes. Fetch it
  // directly WITHOUT the auth header — the presigned URL self-authenticates (SigV4 in the
  // query), and R2 rejects a request that also carries a Bearer header. Streaming fallback
  // (no R2 configured) returns the audio bytes inline, so branch on content-type.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const { url } = await readJson<{ url: string }>(res, "stem fetch");
    const r2 = await fetchWithTimeout(url, {}, TRANSFER_TIMEOUT_MS);
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
  diag(`separate: POST start (${formatMb(bytes.byteLength)}MB)`);
  const jobId = await startSeparation(bytes, fileName, durationMs, projectId);
  diag(`separate: jobId=${jobId}`);
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;
  for (let i = 0; i < MAX_POLLS; i++) {
    let st: SeparationStatus;
    try {
      st = await pollSeparation(jobId);
      consecutiveErrors = 0;
    } catch (e) {
      // The job runs server-side regardless; a transient network/5xx blip must not kill an
      // already-charged separation. Tolerate a few in a row, then give up (still recoverable
      // from history). A persistent failure (real outage / 401) exhausts the cap and throws.
      if (++consecutiveErrors > MAX_CONSECUTIVE_ERRORS) throw e;
      diag(`poll #${i}: transient error ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }
    onProgress?.(st.progress, st.progressReason);
    if (i === 0 || st.status === "ready" || st.status === "failed") {
      diag(`poll #${i}: ${st.status} ${st.progress}% stems=${st.stems?.length ?? 0}`);
    }
    if (st.status === "ready") {
      // voice_all("모든 화자" 합본)은 패널에서 불필요 — 개별 화자(speaker_*)와 배경음(background)만 가져온다.
      const wanted = st.stems.filter((m) => m.stemId !== "voice_all");
      diag(`ready: fetching ${wanted.length} stem(s) (voice_all 제외)`);
      const stems = await Promise.all(
        wanted.map(async (m) => {
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
  const res = await fetchWithTimeout(`${BFF_BASE_URL}/api/v2/separations${qs}`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`history list failed: ${check401(res.status)}`);
  const data = await readJson<{ separations: SavedSeparationWire[] }>(res, "history list");
  return (data.separations ?? []).map((s) => ({
    jobId: s.jobId,
    fileName: s.fileName ?? "audio",
    byteLength: s.byteLength ?? 0,
    durationSec: (s.durationMs ?? 0) / 1000,
    createdAt: s.createdAt,
    hasScript: s.hasScript,
    // voice_all("모든 화자" 합본)은 패널에서 불필요 — 개별 화자 + 배경음만. (runSeparation 과 동일 필터)
    stems: (s.stems ?? []).filter((m) => m.stemId !== "voice_all"),
  }));
}

// Permanently delete a saved separation (row + stems on disk and R2). Idempotent server-side.
export async function deleteSeparation(jobId: string): Promise<void> {
  const res = await fetchWithTimeout(`${BFF_BASE_URL}/api/v2/separate/${jobId}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!res.ok && res.status !== 204) throw new Error(`history delete failed: ${check401(res.status)}`);
}

// Fetch the diarized script the separation already produced (fast — no separate STT job).
export async function fetchSeparationScript(jobId: string): Promise<ScriptDraft> {
  const res = await fetchWithTimeout(`${BFF_BASE_URL}/api/v2/separate/${jobId}/script`, {
    headers: await authHeader(),
  });
  if (!res.ok) throw new Error(`script fetch failed: ${check401(res.status)}`);
  const draft = await readJson<ScriptDraft>(res, "script fetch");
  // Normalize auto/Korean default speaker names to the canonical English label so the script
  // matches the separated stems ("Speaker 1" ↔ the "speaker_1" stem); user-renamed labels are kept.
  return {
    ...draft,
    speakers: (draft.speakers ?? []).map((sp) =>
      isAutoSpeakerLabel(sp.label) ? { ...sp, label: defaultSpeakerLabel(sp.index) } : sp,
    ),
  };
}
