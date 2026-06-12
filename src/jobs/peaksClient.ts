import { BFF_BASE_URL } from "../config";
import { authHeader } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { buildMultipart } from "./multipart";
import { readJson } from "./http";

export interface RemotePeaks {
  peaks: Float32Array;
  durationSec: number;
}

// Ask the server to decode the input (mp3/m4a/wav) and return waveform peaks. Used for the
// input preview when the UXP panel can't decode the format itself. No credit charge.
export async function fetchPeaks(bytes: ArrayBuffer, fileName: string): Promise<RemotePeaks> {
  const { body, contentType } = buildMultipart({}, [{ field: "audio", fileName, bytes }]);
  const res = await fetch(`${BFF_BASE_URL}/api/v2/peaks`, {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": contentType },
    body,
  });
  if (!res.ok) throw new Error(`peaks failed: ${check401(res.status)}`);
  const data = await readJson<{ peaks: number[]; durationSec: number }>(res, "peaks");
  return { peaks: Float32Array.from(data.peaks), durationSec: data.durationSec };
}
