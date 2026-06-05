import { BFF_BASE_URL } from "../config";
import { loadToken } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { buildMultipart } from "../jobs/multipart";

export interface MixSource {
  audioUrl: string;
  volume: number;
}

// Mix selected stems on the server (ffmpeg). The panel can't do it itself: UXP has no Web
// Audio, and Perso speaker stems aren't always plain WAV PCM (the pure-JS path failed with
// "not WAV PCM"). ffmpeg decodes any stem format and returns a 16-bit PCM WAV.
export async function mixStems(sources: MixSource[]): Promise<ArrayBuffer> {
  if (sources.length === 0) throw new Error("no stems selected");
  const token = await loadToken();
  if (!token) throw new Error("Not signed in");

  const parts = await Promise.all(
    sources.map(async (s) => ({
      bytes: await fetch(s.audioUrl).then((r) => r.arrayBuffer()),
      volume: s.volume,
    })),
  );

  const { body, contentType } = buildMultipart(
    { volumes: parts.map((p) => p.volume).join(",") },
    parts.map((p, i) => ({ field: "audio", fileName: `stem${i}.wav`, bytes: p.bytes })),
  );

  const res = await fetch(`${BFF_BASE_URL}/api/v2/mix`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": contentType },
    body,
  });
  if (!res.ok) {
    check401(res.status);
    const detail = await res.text().catch(() => "");
    throw new Error(`mix failed: ${res.status} ${detail}`);
  }
  return res.arrayBuffer();
}
