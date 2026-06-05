import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { sign, verify } from "hono/jwt";
import { OAuth2Client } from "google-auth-library";
import {
  authorizeUserCode,
  createDeviceCode,
  deleteDeviceCode,
  pollDeviceCode,
  DEVICE_CODE_TTL_MS,
  type DeviceUser,
} from "../auth/deviceStore.js";
import { issueToken } from "../auth/jwt.js";
import { ensureUser } from "../credit/creditStore.js";
import { brandHeader, brandPageStyles } from "../brand.js";

export const authRoute = new Hono();

function publicBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL ?? "http://localhost:8787";
}

function stateSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return s;
}

// Distinct audience for the short-lived OAuth `state` token so it can't be replayed as an
// access token (which requires aud=vibi-access — see auth/jwt.ts).
const STATE_AUDIENCE = "vibi-oauth-state";

function googleClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set");
  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: `${publicBaseUrl()}/api/v2/auth/google/callback`,
  });
}

authRoute.post("/api/v2/auth/device/start", async (c) => {
  const record = await createDeviceCode();
  const base = publicBaseUrl();
  return c.json({
    deviceCode: record.deviceCode,
    userCode: record.userCode,
    verificationUri: `${base}/device`,
    verificationUriComplete: `${base}/device?code=${record.userCode}`,
    expiresIn: Math.floor(DEVICE_CODE_TTL_MS / 1000),
    interval: 2,
  });
});

authRoute.post("/api/v2/auth/device/poll", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const deviceCode = typeof body.deviceCode === "string" ? body.deviceCode : "";
  const record = await pollDeviceCode(deviceCode);
  if (!record) return c.json({ error: "invalid_device_code" }, 404);
  if (record.status === "expired") return c.json({ error: "expired" }, 410);
  if (record.status === "pending") return c.json({ status: "authorization_pending" }, 200);
  if (record.status === "authorized" && record.user) {
    const issued = await issueToken(record.user);
    // Single-use: consume the code so it can't be re-polled to mint more tokens.
    await deleteDeviceCode(deviceCode);
    return c.json({ status: "authorized", ...issued });
  }
  return c.json({ status: "authorization_pending" }, 200);
});

// Step 1 of the browser flow: redirect the user to Google's consent screen.
// `state` is a short-lived signed token carrying the device user-code so the
// callback can tie the Google identity back to the waiting plugin session.
authRoute.get("/api/v2/auth/google/start", async (c) => {
  const userCode = c.req.query("code") ?? "";
  if (!userCode) return c.text("missing code", 400);
  let client: OAuth2Client;
  try {
    client = googleClient();
  } catch {
    return c.text("Google sign-in is not configured on the server.", 500);
  }
  const state = await sign(
    { userCode, n: randomUUID(), aud: STATE_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 600 },
    stateSecret(),
  );
  const url = client.generateAuthUrl({
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
  return c.redirect(url);
});

// Step 2: Google redirects back here with an auth code. Verify the id_token,
// upsert the user, and mark the device code authorized.
authRoute.get("/api/v2/auth/google/callback", async (c) => {
  const code = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  if (!code || !state) return c.html(resultPage(false, "Missing code/state."), 400);

  let userCode: string;
  try {
    const decoded = (await verify(state, stateSecret(), "HS256")) as { userCode?: string; aud?: string };
    if (decoded.aud !== STATE_AUDIENCE) throw new Error("wrong state audience");
    userCode = decoded.userCode ?? "";
    if (!userCode) throw new Error("no userCode in state");
  } catch {
    return c.html(resultPage(false, "Invalid or expired sign-in state."), 400);
  }

  try {
    const client = googleClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) throw new Error("no id_token");
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) throw new Error("no sub in id_token");

    const email = payload.email ?? "";
    const name = payload.name ?? payload.email?.split("@")[0] ?? "user";
    // Resolve to the internal users.id (uuid); that becomes the identity in the JWT.
    const uid = await ensureUser("google", payload.sub, email, name);
    const user: DeviceUser = { sub: uid, email, name };

    const record = await authorizeUserCode(userCode, user);
    if (!record) return c.html(resultPage(false, "Code not found. Restart from the plugin."), 404);
    if (record.status === "expired") return c.html(resultPage(false, "Code expired. Restart from the plugin."), 410);
    return c.html(resultPage(true, "Signed in. Return to the plugin — it continues automatically."));
  } catch (e) {
    console.error("[auth] google callback failed:", e);
    return c.html(resultPage(false, "Sign-in failed. Please try again."), 500);
  }
});

// DEV ONLY: bypass Google for local testing. Enabled solely when AUTH_DEV_BYPASS=true.
// Never enable in production — it accepts any email with no verification.
authRoute.post("/api/v2/auth/dev/authorize", async (c) => {
  if (process.env.AUTH_DEV_BYPASS !== "true") return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const userCode = typeof body.userCode === "string" ? body.userCode : "";
  const email = typeof body.email === "string" ? body.email.trim() : "dev@example.com";
  // provider CHECK allows only google/apple, so dev users land under google with a dev: sub.
  const uid = await ensureUser("google", `dev:${email}`, email, email.split("@")[0]);
  const user: DeviceUser = { sub: uid, email, name: email.split("@")[0] };
  const record = await authorizeUserCode(userCode, user);
  if (!record) return c.json({ error: "invalid_user_code" }, 404);
  if (record.status === "expired") return c.json({ error: "expired" }, 410);
  return c.json({ ok: true });
});

function resultPage(ok: boolean, message: string): string {
  const color = ok ? "#4fd18b" : "#ff7066";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>vibi sign-in</title>
<style>${brandPageStyles()} .msg{margin:0;font-size:14px;color:${color}}</style></head>
<body><div class="card">${brandHeader()}<p class="msg">${message}</p></div></body></html>`;
}
