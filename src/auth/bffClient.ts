import { BFF_BASE_URL } from "../config";
import { fetchWithTimeout, readJson } from "../jobs/http";

export interface DeviceStartResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceUser {
  sub: string;
  email: string;
  name: string;
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "error" }
  | { status: "authorized"; accessToken: string; expiresAt: number; user: DeviceUser };

/**
 * Browser sign-in URL that skips the `/device` confirmation page and opens Google consent
 * directly. We build it client-side (rather than using the response's verificationUriComplete)
 * so it works against the already-deployed BFF without waiting on a redeploy.
 *
 * The BFF's `google/start` requires `ack=on` — a consent-relay phishing backstop the manual
 * `/device` page collects via a checkbox. The panel passes it here because clicking "Sign in"
 * in Premiere (which auto-opens the browser on the same machine moments later) *is* the
 * explicit consent. Trade-off: this bypasses that checkbox mitigation — acceptable for a
 * desktop panel where the same user both starts and finishes the flow.
 */
export function googleDeviceSignInUrl(userCode: string): string {
  return `${BFF_BASE_URL}/api/v2/auth/google/start?code=${encodeURIComponent(userCode)}&ack=on`;
}

export async function deviceStart(): Promise<DeviceStartResponse> {
  const res = await fetchWithTimeout(`${BFF_BASE_URL}/api/v2/auth/device/start`, { method: "POST" });
  if (!res.ok) throw new Error(`device/start failed: ${res.status}`);
  return readJson<DeviceStartResponse>(res, "device/start");
}

export async function devicePoll(deviceCode: string): Promise<DevicePollResult> {
  const res = await fetchWithTimeout(`${BFF_BASE_URL}/api/v2/auth/device/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  if (res.status === 410) return { status: "expired" };
  if (res.status === 404) return { status: "error" };
  const data = await res.json().catch(() => ({}));
  // Only treat as authorized when the token shape is actually usable: a malformed body with a
  // missing/NaN expiresAt or absent user would otherwise be stored and then rejected by
  // loadToken's finite-expiry guard — the user would appear signed-out right after signing in.
  if (
    data.status === "authorized" &&
    typeof data.accessToken === "string" &&
    Number.isFinite(data.expiresAt) &&
    data.user
  ) {
    return {
      status: "authorized",
      accessToken: data.accessToken,
      expiresAt: data.expiresAt,
      user: data.user,
    };
  }
  return { status: "pending" };
}
