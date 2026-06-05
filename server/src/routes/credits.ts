import { Hono } from "hono";
import { currentUser, requireAuth } from "../auth/middleware.js";
import { creditsForDuration, getBalance } from "../credit/creditStore.js";

export const creditsRoute = new Hono();

creditsRoute.get("/api/v2/credits", requireAuth, async (c) => {
  const user = currentUser(c);
  return c.json({ balance: await getBalance(user.sub) });
});

creditsRoute.get("/api/v2/credits/cost", requireAuth, async (c) => {
  const user = currentUser(c);
  const durationMs = Number(c.req.query("durationMs") ?? 0);
  const credits = creditsForDuration(durationMs);
  const balance = await getBalance(user.sub);
  return c.json({ durationMs, credits, balance, sufficient: balance >= credits });
});
