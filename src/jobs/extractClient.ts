import { BFF_BASE_URL } from "../config";
import { loadToken } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { buildMultipart } from "./multipart";

// Ask the server to extract a media file's audio track to mp3 (ffmpeg). Used for video selections
// (e.g. a .mov on the timeline) whose audio we want to separate. We upload the file BYTES (read
// locally via UXP), NOT a path — a path-based call let the server ffmpeg-open arbitrary local
// paths/URLs (SSRF/LFI) and only worked when the server ran on the same machine as Premiere.
export async function extractAudioFromBytes(bytes: ArrayBuffer, fileName: string): Promise<ArrayBuffer> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in");
  const { body, contentType } = buildMultipart({}, [{ field: "media", fileName, bytes }]);
  const res = await fetch(`${BFF_BASE_URL}/api/v2/extract-audio`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": contentType },
    body,
  });
  if (!res.ok) {
    check401(res.status);
    const detail = await res.text().catch(() => "");
    throw new Error(`extract failed: ${res.status} ${detail}`);
  }
  return res.arrayBuffer();
}
