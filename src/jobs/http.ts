// Parse a successful response body as JSON. A 2xx with a non-JSON body — a proxy splash page, a
// gateway interstitial, a truncated/gzip-mismatched payload — makes `res.json()` reject with a
// raw "SyntaxError: Unexpected token <". This turns that into a clear, user-facing message.
// Call only after the `res.ok` check.
export async function readJson<T>(res: Response, context: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${context}: unexpected response from server`);
  }
}

// Default deadline for control-plane calls (sign-in, status polls, balance, metadata). Bulk
// transfers (audio upload / stem download) legitimately take longer, so those pass a larger value.
export const REQUEST_TIMEOUT_MS = 30_000;
// Audio byte transfers: up to MAX_AUDIO_BYTES (200MB) over a slow uplink can take minutes.
export const TRANSFER_TIMEOUT_MS = 10 * 60_000;

// fetch() with a hard timeout. Without it a stalled or captive-portal network leaves the request
// pending forever — the Sign-in button spins with no recovery, a poll never settles. UXP's fetch
// supports AbortController, but to stay robust even if a runtime ignores the signal we ALSO race a
// timeout promise, so the caller always gets a clear, retryable error after `timeoutMs`.
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      reject(new Error("Network request timed out. Check your connection and try again."));
    }, timeoutMs);
  });
  const fetchPromise = fetch(input, { ...init, signal: controller.signal });
  // When the timeout wins the race we abort the fetch; its later AbortError rejection would
  // otherwise be an unhandled rejection (Promise.race doesn't handle the loser). Swallow it.
  fetchPromise.catch(() => {});
  try {
    return await Promise.race([fetchPromise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
