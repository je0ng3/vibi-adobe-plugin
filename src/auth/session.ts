// Central "session expired" signal. The access token can expire mid-session and there's no
// refresh, so any authed API call may come back 401. API clients call notifyUnauthorized() on a
// 401; App registers a handler that clears the token and returns to the login screen with a notice.
let handler: (() => void) | null = null;

export function setUnauthorizedHandler(cb: (() => void) | null): void {
  handler = cb;
}

// Call when a request fails auth (HTTP 401). Safe to call repeatedly; no-op if nothing registered.
export function notifyUnauthorized(): void {
  handler?.();
}

// Convenience for clients: signal session-expiry on a 401 response, then let the caller throw as
// usual. Returns the status so it can be chained inline.
export function check401(status: number): number {
  if (status === 401) notifyUnauthorized();
  return status;
}
