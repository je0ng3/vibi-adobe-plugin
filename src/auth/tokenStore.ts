import { storage } from "uxp";

const TOKEN_KEY = "vibi.accessToken";
const EXPIRES_AT_KEY = "vibi.expiresAt";

export interface AuthToken {
  accessToken: string;
  expiresAt: number;
}

// Session source of truth. secureStorage persistence is best-effort and can silently fail
// in the real UXP runtime (no OS keychain access); sign-in still succeeds in-memory via the
// LoginView callback. Without this cache the API clients would re-read a token that was
// never persisted and get null → "Not signed in" right after a successful sign-in.
let cached: AuthToken | null = null;

export async function loadToken(): Promise<AuthToken | null> {
  if (cached) return cached;
  const accessToken = await readSecret(TOKEN_KEY);
  const expiresAtRaw = await readSecret(EXPIRES_AT_KEY);
  if (!accessToken || !expiresAtRaw) return null;
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt)) return null;
  cached = { accessToken, expiresAt };
  return cached;
}

export async function saveToken(token: AuthToken): Promise<void> {
  // Cache first so the session holds the token even if the writes below throw.
  cached = token;
  await writeSecret(TOKEN_KEY, token.accessToken);
  await writeSecret(EXPIRES_AT_KEY, String(token.expiresAt));
}

export async function clearToken(): Promise<void> {
  cached = null;
  await storage.secureStorage.removeItem(TOKEN_KEY);
  await storage.secureStorage.removeItem(EXPIRES_AT_KEY);
}

export function isExpired(token: AuthToken, nowMs: number = Date.now()): boolean {
  return token.expiresAt <= nowMs;
}

// UXP has no global TextEncoder/TextDecoder (confirmed: ReferenceError in the real runtime).
// Token values are pure ASCII (JWT base64url + a decimal timestamp), so a direct byte<->char
// conversion is lossless and needs no globals — works even if uxp-polyfills.js never loads.
function asciiToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
  return bytes;
}

function bytesToAscii(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

async function readSecret(key: string): Promise<string | null> {
  const raw = await storage.secureStorage.getItem(key);
  if (raw == null) return null;
  const text = (raw instanceof Uint8Array ? bytesToAscii(raw) : String(raw)).trim();
  return text.length === 0 ? null : text;
}

async function writeSecret(key: string, value: string): Promise<void> {
  await storage.secureStorage.setItem(key, asciiToBytes(value));
}
