import type { Context, Next } from "hono";
import { verifyToken, type AccessTokenPayload } from "./jwt.js";

export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }
  try {
    const payload = await verifyToken(header.slice("Bearer ".length));
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: "invalid_token" }, 401);
  }
}

export function currentUser(c: Context): AccessTokenPayload {
  return c.get("user") as AccessTokenPayload;
}
