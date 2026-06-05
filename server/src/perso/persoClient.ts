import { PERSO_API_BASE, persoApiKey, persoSpaceSeq, resolveDownloadUrl } from "./persoConfig.js";
import {
  PersoApiError,
  type PersoMediaRegistration,
  type PersoProgress,
  type PersoDownloadInfo,
  type PersoProjectInfo,
  type PersoSasTokenResponse,
  type PersoScriptPage,
  type PersoSeparationDownloadLinks,
  type PersoTranslateDownloadLinks,
} from "./persoTypes.js";

async function checkResponse(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PersoApiError(res.status, body);
  }
}

async function withTransientRetry<T>(label: string, block: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await block();
    } catch (e) {
      if (e instanceof PersoApiError && e.status >= 400 && e.status < 500) throw e;
      lastErr = e;
      console.warn(`[perso] ${label} attempt ${attempt + 1}/${MAX_ATTEMPTS} failed:`, e);
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr ?? new Error(`${label} failed after ${MAX_ATTEMPTS} attempts`);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "XP-API-KEY": persoApiKey(), ...extra };
}

/**
 * Most Perso endpoints wrap the payload in `{ result: ... }`, but some return the raw
 * object (KNOWN_ISSUES.md "getProjectInfo envelope may be missing"). Accept both shapes so
 * a missing envelope doesn't yield `undefined` and crash the caller mid-poll.
 */
function unwrapResult<T>(body: unknown): T {
  if (body && typeof body === "object" && "result" in body && (body as { result?: unknown }).result != null) {
    return (body as { result: T }).result;
  }
  return body as T;
}

export async function getSasToken(fileName: string): Promise<PersoSasTokenResponse> {
  return withTransientRetry(`getSasToken(${fileName})`, async () => {
    const encoded = encodeURIComponent(fileName);
    const res = await fetch(`${PERSO_API_BASE}/file/api/upload/sas-token?fileName=${encoded}`, {
      method: "GET",
      headers: authHeaders(),
    });
    await checkResponse(res);
    return (await res.json()) as PersoSasTokenResponse;
  });
}

export async function uploadToBlob(sasUrl: string, audio: ArrayBuffer): Promise<void> {
  const res = await fetch(sasUrl, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "Content-Type": "application/octet-stream" },
    body: audio,
  });
  await checkResponse(res);
}

export async function registerAudio(sasUrl: string, fileName: string): Promise<PersoMediaRegistration> {
  const fileUrl = sasUrl.split("?")[0];
  return withTransientRetry(`registerAudio(${fileName})`, async () => {
    const res = await fetch(`${PERSO_API_BASE}/file/api/upload/audio`, {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ spaceSeq: persoSpaceSeq(), fileUrl, fileName }),
    });
    await checkResponse(res);
    return (await res.json()) as PersoMediaRegistration;
  });
}

export async function uploadAudio(audio: ArrayBuffer, fileName: string): Promise<PersoMediaRegistration> {
  const sas = await getSasToken(fileName);
  await uploadToBlob(sas.blobSasUrl, audio);
  return registerAudio(sas.blobSasUrl, fileName);
}

export async function submitStt(mediaSeq: number, title?: string): Promise<number> {
  return withTransientRetry(`submitStt(${mediaSeq})`, async () => {
    const res = await fetch(
      `${PERSO_API_BASE}/video-translator/api/v1/projects/spaces/${persoSpaceSeq()}/stt`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ mediaSeq, isVideoProject: false, title: title ?? null }),
      },
    );
    await checkResponse(res);
    const env = (await res.json()) as { result?: { startGenerateProjectIdList?: number[] } };
    const first = env.result?.startGenerateProjectIdList?.[0];
    if (first == null) throw new PersoApiError(500, "empty startGenerateProjectIdList");
    return first;
  });
}

export async function getProgress(projectSeq: number): Promise<PersoProgress> {
  return withTransientRetry(`getProgress(${projectSeq})`, async () => {
    const res = await fetch(
      `${PERSO_API_BASE}/video-translator/api/v1/projects/${projectSeq}/space/${persoSpaceSeq()}/progress`,
      { method: "GET", headers: authHeaders() },
    );
    await checkResponse(res);
    return unwrapResult<PersoProgress>(await res.json());
  });
}

export async function getSttScript(projectSeq: number, cursorId?: number): Promise<PersoScriptPage> {
  return withTransientRetry(`getSttScript(${projectSeq},${cursorId ?? "start"})`, async () => {
    const base = `${PERSO_API_BASE}/video-translator/api/v1/projects/${projectSeq}/spaces/${persoSpaceSeq()}/stt/script`;
    const url = cursorId != null ? `${base}?cursorId=${cursorId}` : base;
    const res = await fetch(url, { method: "GET", headers: authHeaders() });
    await checkResponse(res);
    return unwrapResult<PersoScriptPage>(await res.json());
  });
}

export async function submitAudioSeparation(mediaSeq: number, title?: string): Promise<number> {
  return withTransientRetry(`submitAudioSeparation(${mediaSeq})`, async () => {
    const res = await fetch(
      `${PERSO_API_BASE}/video-translator/api/v1/projects/spaces/${persoSpaceSeq()}/audio-separation`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ mediaSeq, isVideoProject: false, title: title ?? null }),
      },
    );
    await checkResponse(res);
    const env = (await res.json()) as { result?: { startGenerateProjectIdList?: number[] } };
    const first = env.result?.startGenerateProjectIdList?.[0];
    if (first == null) throw new PersoApiError(500, "empty startGenerateProjectIdList");
    return first;
  });
}

export async function getProjectInfo(projectSeq: number): Promise<PersoProjectInfo> {
  return withTransientRetry(`getProjectInfo(${projectSeq})`, async () => {
    const res = await fetch(
      `${PERSO_API_BASE}/video-translator/api/v1/projects/${projectSeq}/spaces/${persoSpaceSeq()}`,
      { method: "GET", headers: authHeaders() },
    );
    await checkResponse(res);
    const body = (await res.json()) as PersoProjectInfo | { result: PersoProjectInfo };
    return "result" in (body as { result?: unknown }) && (body as { result?: unknown }).result != null
      ? (body as { result: PersoProjectInfo }).result
      : (body as PersoProjectInfo);
  });
}

export async function getSeparationDownloadLinks(
  projectSeq: number,
  target: "originalVoiceSpeakers" | "originalSubBackground",
): Promise<PersoSeparationDownloadLinks> {
  return withTransientRetry(`getSeparationDownloadLinks(${projectSeq},${target})`, async () => {
    const res = await fetch(
      `${PERSO_API_BASE}/video-translator/api/v1/projects/${projectSeq}/spaces/${persoSpaceSeq()}/download?target=${target}`,
      { method: "GET", headers: authHeaders() },
    );
    await checkResponse(res);
    return unwrapResult<PersoSeparationDownloadLinks>(await res.json());
  });
}

export async function submitTranslate(
  mediaSeq: number,
  sourceLanguageCode: string,
  targetLanguageCodes: string[],
  numberOfSpeakers: number,
  title?: string,
): Promise<number> {
  return withTransientRetry(`submitTranslate(${mediaSeq})`, async () => {
    const res = await fetch(
      `${PERSO_API_BASE}/video-translator/api/v1/projects/spaces/${persoSpaceSeq()}/translate`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          mediaSeq,
          isVideoProject: false,
          sourceLanguageCode,
          targetLanguageCodes,
          numberOfSpeakers,
          title: title ?? null,
        }),
      },
    );
    await checkResponse(res);
    const env = (await res.json()) as { result?: { startGenerateProjectIdList?: number[] } };
    const first = env.result?.startGenerateProjectIdList?.[0];
    if (first == null) throw new PersoApiError(500, "empty startGenerateProjectIdList");
    return first;
  });
}

export async function getDownloadInfo(projectSeq: number): Promise<PersoDownloadInfo> {
  return withTransientRetry(`getDownloadInfo(${projectSeq})`, async () => {
    const res = await fetch(
      `${PERSO_API_BASE}/video-translator/api/v1/projects/${projectSeq}/spaces/${persoSpaceSeq()}/download-info`,
      { method: "GET", headers: authHeaders() },
    );
    await checkResponse(res);
    const env = (await res.json()) as { result?: PersoDownloadInfo } | PersoDownloadInfo;
    return "result" in env && env.result != null ? env.result : (env as PersoDownloadInfo);
  });
}

export async function getTranslateDownloadLinks(projectSeq: number): Promise<PersoTranslateDownloadLinks> {
  return withTransientRetry(`getTranslateDownloadLinks(${projectSeq})`, async () => {
    const res = await fetch(
      `${PERSO_API_BASE}/video-translator/api/v1/projects/${projectSeq}/spaces/${persoSpaceSeq()}/download?target=translatedAudio`,
      { method: "GET", headers: authHeaders() },
    );
    await checkResponse(res);
    return unwrapResult<PersoTranslateDownloadLinks>(await res.json());
  });
}

export async function streamDownload(downloadUrl: string): Promise<ArrayBuffer> {
  const { url, needsAuth } = resolveDownloadUrl(downloadUrl);
  const res = await fetch(url, {
    method: "GET",
    headers: needsAuth ? authHeaders() : undefined,
  });
  await checkResponse(res);
  return res.arrayBuffer();
}

export async function getFullSttScript(projectSeq: number): Promise<PersoScriptPage> {
  const sentences: PersoScriptPage["sentences"] = [];
  let speakers: PersoScriptPage["speakers"] = [];
  let cursorId: number | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await getSttScript(projectSeq, cursorId);
    sentences.push(...page.sentences);
    if (page.speakers.length > 0) speakers = page.speakers;
    if (!page.hasNext || page.nextCursorId == null) break;
    cursorId = page.nextCursorId;
  }
  return { hasNext: false, nextCursorId: null, sentences, speakers };
}

// The diarized script the audio-separation project ALREADY produced. Far cheaper than a separate
// STT job: no upload/submit/long poll — just read it off the existing separation projectSeq.
export async function getAudioSeparationScript(projectSeq: number, cursorId?: number): Promise<PersoScriptPage> {
  return withTransientRetry(`getAudioSeparationScript(${projectSeq},${cursorId ?? "start"})`, async () => {
    const base = `${PERSO_API_BASE}/video-translator/api/v1/projects/${projectSeq}/spaces/${persoSpaceSeq()}/audio-separation/script`;
    const url = cursorId != null ? `${base}?cursorId=${cursorId}` : base;
    const res = await fetch(url, { method: "GET", headers: authHeaders() });
    await checkResponse(res);
    return unwrapResult<PersoScriptPage>(await res.json());
  });
}

export async function getFullAudioSeparationScript(projectSeq: number): Promise<PersoScriptPage> {
  const sentences: PersoScriptPage["sentences"] = [];
  let speakers: PersoScriptPage["speakers"] = [];
  let cursorId: number | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await getAudioSeparationScript(projectSeq, cursorId);
    sentences.push(...page.sentences);
    if (page.speakers.length > 0) speakers = page.speakers;
    if (!page.hasNext || page.nextCursorId == null) break;
    cursorId = page.nextCursorId;
  }
  return { hasNext: false, nextCursorId: null, sentences, speakers };
}
