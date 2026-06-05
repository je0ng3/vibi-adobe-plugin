import { BFF_BASE_URL } from "../config";
import { loadToken } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { buildMultipart } from "./multipart";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

// Isolate one speaker from the original audio by time ranges (server ffmpeg). Returns a full-length
// WAV with audio only during the ranges (silence elsewhere) — used by the script-based editable
// separation flow, called once per speaker. UXP can't cut audio itself, so this goes to the BFF.
export async function segmentSpeaker(audioBytes: ArrayBuffer, ranges: TimeRange[]): Promise<ArrayBuffer> {
  const token = await loadToken();
  if (!token) throw new Error("Not signed in");

  const { body, contentType } = buildMultipart(
    { ranges: JSON.stringify(ranges) },
    [{ field: "audio", fileName: "source.wav", bytes: audioBytes }],
  );

  const res = await fetch(`${BFF_BASE_URL}/api/v2/segment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": contentType },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`segment failed: ${check401(res.status)} ${detail}`);
  }
  return res.arrayBuffer();
}
