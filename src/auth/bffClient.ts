import { BFF_BASE_URL } from "../config";

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

export async function deviceStart(): Promise<DeviceStartResponse> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/auth/device/start`, { method: "POST" });
  if (!res.ok) throw new Error(`device/start failed: ${res.status}`);
  return res.json();
}

export async function devicePoll(deviceCode: string): Promise<DevicePollResult> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/auth/device/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  if (res.status === 410) return { status: "expired" };
  if (res.status === 404) return { status: "error" };
  const data = await res.json().catch(() => ({}));
  if (data.status === "authorized" && data.accessToken) {
    return {
      status: "authorized",
      accessToken: data.accessToken,
      expiresAt: data.expiresAt,
      user: data.user,
    };
  }
  return { status: "pending" };
}
