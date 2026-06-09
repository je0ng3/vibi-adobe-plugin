import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { authRoute } from "./routes/auth.js";
import { devicePageRoute } from "./routes/devicePage.js";
import { separationRoute } from "./routes/separation.js";
import { peaksRoute } from "./routes/peaks.js";
import { transcriptRoute } from "./routes/transcript.js";
import { creditsRoute } from "./routes/credits.js";
import { paddleRoute } from "./routes/paddle.js";
import { ensureSchema } from "./db/pool.js";
import { startCleanupSweep } from "./jobs/cleanup.js";
import { rateLimit } from "./middleware/rateLimit.js";

const IS_PROD = process.env.NODE_ENV === "production";

// Fail fast on insecure production config rather than silently running wide-open. A single
// mis-set env var must not (a) leave CORS reflecting every origin or (b) expose the
// no-verification dev auth bypass.
function assertProdConfig(originAllowlist: string[]): void {
  if (!IS_PROD) return;
  const problems: string[] = [];
  if (originAllowlist.length === 0) problems.push("ALLOWED_ORIGINS is empty");
  if (process.env.AUTH_DEV_BYPASS === "true") problems.push("AUTH_DEV_BYPASS is enabled");
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

app.route("/", healthRoute);
app.route("/", authRoute);
app.route("/", devicePageRoute);
app.route("/", separationRoute);
app.route("/", peaksRoute);
app.route("/", transcriptRoute);
app.route("/", creditsRoute);
app.route("/", paddleRoute);

const port = Number(process.env.PORT ?? 8787);

async function main() {
  assertProdConfig(allowed);
  await ensureSchema();
  startCleanupSweep();
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`vibi plugin server listening on http://localhost:${info.port}`);
  });
}

main().catch((e) => {
  console.error("failed to start server:", e);
  process.exit(1);
});
