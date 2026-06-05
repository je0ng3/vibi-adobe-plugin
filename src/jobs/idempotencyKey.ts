// A stable key per logical submit. Sent as the `Idempotency-Key` header so the server
// charges credits and creates the job exactly once even if the POST is retried at the
// transport layer. Generate it ONCE per submit and reuse on retry — a fresh key defeats
// the guarantee. Not a secret, so crypto isn't required, but prefer it when available.
export function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
