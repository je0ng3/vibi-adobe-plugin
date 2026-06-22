import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { authRoute } from "./routes/auth.js";
import { devicePageRoute } from "./routes/devicePage.js";
import { separationRoute } from "./routes/separation.js";
import { peaksRoute } from "./routes/peaks.js";
import { creditsRoute } from "./routes/credits.js";
import { paddleRoute } from "./routes/paddle.js";
import { ensureSchema } from "./db/pool.js";
import { failStaleJobs } from "./jobs/jobStore.js";
import { startCleanupSweep } from "./jobs/cleanup.js";
import { rateLimit } from "./middleware/rateLimit.js";

const IS_PROD = process.env.NODE_ENV === "production";

// Fail fast on insecure production config rather than silently running wide-open. A single
// mis-set env var must not (a) leave CORS reflecting every origin or (b) expose the
// no-verification dev auth bypass.
// Minimum JWT_SECRET length in production. Access tokens are HMAC-signed (HS256) and stateless
// (no server-side revocation), so a weak/guessable secret lets an attacker forge a token for ANY
// user — full account + credit takeover. Refuse to boot prod on a short secret.
const MIN_JWT_SECRET_LEN = 32;

function assertProdConfig(originAllowlist: string[]): void {
  if (!IS_PROD) return;
  const problems: string[] = [];
  if (originAllowlist.length === 0) problems.push("ALLOWED_ORIGINS is empty");
  if (process.env.AUTH_DEV_BYPASS === "true") problems.push("AUTH_DEV_BYPASS is enabled");
  const secret = process.env.JWT_SECRET ?? "";
  if (secret.length < MIN_JWT_SECRET_LEN) {
    problems.push(`JWT_SECRET is missing or shorter than ${MIN_JWT_SECRET_LEN} characters`);
  }
  if (problems.length > 0) {
    throw new Error(`refusing to start in production: ${problems.join("; ")}`);
  }
}

const app = new Hono();

// CORS: restrict to an explicit allowlist in production. UXP plugin requests send no
// Origin header and are unaffected; this guards the browser-facing endpoints.
const allowed = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (allowed.length === 0) {
  console.warn("[cors] ALLOWED_ORIGINS not set — allowing all origins (dev only).");
}
app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      if (allowed.length === 0) return origin ?? "*";
      return allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key"],
  }),
);

// Rate limit the unauthenticated, abusable endpoints here (keyed on IP — no user yet).
// The authenticated expensive endpoints (/separate, /credits/checkout) are limited inside
// their routes AFTER requireAuth, so the limiter can key on the user instead of a shared
// NAT IP — see those route files.
app.use("/api/v2/auth/device/start", rateLimit({ windowMs: 60_000, max: 20 }));
app.use("/api/v2/auth/device/poll", rateLimit({ windowMs: 60_000, max: 60 }));
// The browser OAuth endpoints are unauthenticated too: limit them so the Google token-exchange /
// id_token-verification work (and the state-verify on the callback) can't be hammered.
app.use("/api/v2/auth/google/start", rateLimit({ windowMs: 60_000, max: 20 }));
app.use("/api/v2/auth/google/callback", rateLimit({ windowMs: 60_000, max: 20 }));
// Signature verification is the real gate on the webhook (cheap HMAC over a small body, rejects
// forgeries). Paddle delivers ALL customers' events from a small fixed IP range, so an IP-keyed
// limit collapses every customer onto one counter — set it well above any legitimate burst/retry
// volume so it only ever trips on a single-source flood, never on real credit-granting events.
app.use("/api/v2/paddle/webhook", rateLimit({ windowMs: 60_000, max: 600 }));

app.route("/", healthRoute);
app.route("/", authRoute);
app.route("/", devicePageRoute);
app.route("/", separationRoute);
app.route("/", peaksRoute);
app.route("/", creditsRoute);
app.route("/", paddleRoute);

// Single error funnel: any route that lets a throw escape (DB/R2/Perso call, bad input) returns
// a clean, uniform 500 here instead of Hono's default, which echoes the raw error message — and
// thus internal pg/connection-string detail — back to the client. The real error is logged.
app.onError((err, c) => {
  console.error("[server] unhandled route error:", err);
  return c.json({ error: "internal" }, 500);
});
app.notFound((c) => c.json({ error: "not_found" }, 404));

const port = Number(process.env.PORT ?? 8787);

async function main() {
  assertProdConfig(allowed);
  await ensureSchema();
  const stale = await failStaleJobs();
  if (stale > 0) console.warn(`[startup] marked ${stale} interrupted job(s) as failed`);
  startCleanupSweep();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`vibi plugin server listening on http://localhost:${info.port}`);
  });
}

main().catch((e) => {
  console.error("failed to start server:", e);
  process.exit(1);
});
