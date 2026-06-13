import type { Context } from "hono";
import { objectStore } from "../jobs/objectStore.js";
import { getStemBytes, stemFilePath } from "../jobs/stemStore.js";

/**
 * 큰 산출물(stem) 다운로드 응답 단일 진입점. vibi-bff 의 `respondDownload` 대응.
 *
 * - objectStore != null → 디스크 파일을 R2 에 (멱등) 업로드 후 SigV4 presigned URL 을
 *   `{ url }` JSON 으로 반환. 클라가 그 URL 을 (auth 헤더 없이) 직접 GET → R2 egress 무료.
 * - objectStore == null → 기존 in-memory streaming fallback (로컬 dev / R2 미설정).
 *
 * **bff 와의 차이**: bff 는 302 redirect 를 쓰지만(모바일 네이티브 HTTP 클라가 redirect 를
 * 깔끔히 따라감), UXP 의 fetch 는 redirect 자동 추적/cross-origin 헤더 처리 거동이 불확실해
 * redirect 대신 `{ url }` 을 명시 반환한다. 클라(`fetchStem`)가 content-type 으로 분기.
 *
 * 호출 전 caller 가 auth / 소유권 / status(ready) 검증을 끝낸 상태여야 함.
 */
export async function respondStem(
  c: Context,
  opts: {
    jobId: string;
    stemId: string;
    objectKey: string;
    contentType: string;
    downloadFilename: string;
    notFoundError: string;
  },
): Promise<Response> {
  const { jobId, stemId, objectKey, contentType, downloadFilename, notFoundError } = opts;

  if (objectStore) {
    const present = await objectStore.uploadIfAbsent(objectKey, stemFilePath(jobId, stemId), contentType);
    if (!present) return c.json({ error: notFoundError }, 404);
    const url = await objectStore.signedUrl(objectKey, { contentType, downloadFilename, inline: true });
    // redirect 대신 URL 을 반환 — 클라가 auth 헤더 없이 R2 를 직접 GET (UXP redirect 거동 회피).
    return c.json({ url });
  }

  const bytes = await getStemBytes(jobId, stemId);
  if (!bytes) return c.json({ error: notFoundError }, 404);
  // Explicit Content-Length so the body isn't chunked — UXP's fetch stalls on a chunked binary
  // response (it never resolves arrayBuffer()). The R2 path above avoids this by returning a tiny
  // JSON {url}; this fallback (local dev / R2 unset) must set it itself. Pair with the Caddyfile
  // excluding audio/* from gzip (a compressed binary body has the same effect).
  return c.body(bytes, 200, {
    "Content-Type": contentType,
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": `inline; filename="${downloadFilename}"`,
  });
}

/**
 * R2 object key 단일 소스. 경로 규칙(`<prefix>/<jobId>/...`)을 모아두면 prefix 리네임/
 * lifecycle rule 감사 시 단일 grep 으로 끝남.
 *
 * 디스크에는 stemStore 가 모두 `<stemId>.wav` 로 저장하지만, R2 key 의 확장자는 표시용일 뿐 —
 * 실제 Content-Type 은 presigned URL 의 response-content-type 으로 강제된다.
 */
export const ObjectKey = {
  separationStem: (jobId: string, stemId: string): string => `separation/${jobId}/${stemId}.wav`,
  // All of a separation's stems share this prefix — used to purge them from R2 in one sweep.
  separationPrefix: (jobId: string): string => `separation/${jobId}/`,
};
