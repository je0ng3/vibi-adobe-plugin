import type { Context, Next } from "hono";

// Lightweight in-memory sliding-window limiter. Good enough for a single instance;
// swap for a Redis-backed limiter when running multiple instances.
interface Window {
  count: number;
  resetAt: number;
}

export function rateLimit(opts: { windowMs: number; max: number; key?: (c: Context) => string }) {
  const windows = new Map<string, Window>();
  const keyOf = opts.key ?? defaultKey;

  return async (c: Context, next: Next) => {
    const now = Date.now();
    const k = keyOf(c);
    let w = windows.get(k);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + opts.windowMs };
      windows.set(k, w);
    }
    w.count++;
    if (w.count > opts.max) {
      const retryAfter = Math.ceil((w.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "rate_limited", retryAfter }, 429);
    }
    // Opportunistic cleanup so the map doesn't grow unbounded.
    if (windows.size > 10_000) {
      for (const [key, win] of windows) if (now >= win.resetAt) windows.delete(key);
    }
    await next();
  };
}

function defaultKey(c: Context): string {
  // Prefer the authenticated user; fall back to client IP.
  const user = c.get("user") as { sub?: string } | undefined;
  if (user?.sub) return `u:${user.sub}`;
  const fwd = c.req.header("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
  return `ip:${ip}`;
}
