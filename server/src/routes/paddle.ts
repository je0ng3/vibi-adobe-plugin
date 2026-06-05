import { Hono } from "hono";
import { Environment, EventName, Paddle } from "@paddle/paddle-node-sdk";
import { currentUser, requireAuth } from "../auth/middleware.js";
import { grantPurchase, debitRefund } from "../credit/creditStore.js";
import { brandHeader, brandPageStyles } from "../brand.js";
import { rateLimit } from "../middleware/rateLimit.js";

export const paddleRoute = new Hono();

// After requireAuth so it keys on the user, not a shared NAT IP.
const checkoutLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// Credit packs. Unlike Stripe's inline price_data, Paddle Billing requires each pack
// to map to a catalog Price created in the Paddle Dashboard (pri_...). The Price IDs
// are injected via env so the same code runs against sandbox and production catalogs.
export interface CreditPack {
  id: string;
  credits: number;
  priceCents: number;
  label: string;
  priceId: string;
}

export const CREDIT_PACKS: CreditPack[] = [
  { id: "starter", credits: 50, priceCents: 500, label: "50 credits", priceId: process.env.PADDLE_PRICE_STARTER ?? "" },
  { id: "pro", credits: 200, priceCents: 1500, label: "200 credits", priceId: process.env.PADDLE_PRICE_PRO ?? "" },
  { id: "studio", credits: 1000, priceCents: 5000, label: "1000 credits", priceId: process.env.PADDLE_PRICE_STUDIO ?? "" },
];

const CURRENCY = process.env.PADDLE_CURRENCY ?? "usd";
const IS_PROD = (process.env.PADDLE_ENV ?? "sandbox") === "production";

let paddleClient: Paddle | null = null;
function paddle(): Paddle {
  if (paddleClient) return paddleClient;
  const key = process.env.PADDLE_API_KEY;
  if (!key) throw new Error("PADDLE_API_KEY is not set");
  paddleClient = new Paddle(key, {
    environment: IS_PROD ? Environment.production : Environment.sandbox,
  });
  return paddleClient;
}

function publicBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL ?? "http://localhost:8787";
}

// List available packs (so the plugin UI doesn't hardcode pricing).
paddleRoute.get("/api/v2/credits/packs", requireAuth, (c) => {
  // Don't leak the internal Paddle price IDs to the client.
  const packs = CREDIT_PACKS.map(({ priceId, ...rest }) => rest);
  return c.json({ packs, currency: CURRENCY });
});

// Create a Paddle transaction for a pack, then return the URL of our hosted checkout
// page. The plugin opens that URL in the browser; the page loads Paddle.js and opens
// the overlay against this transaction. customData is set HERE (server-side) so the
// user/credits the webhook grants can't be tampered with from the browser.
paddleRoute.post("/api/v2/credits/checkout", requireAuth, checkoutLimiter, async (c) => {
  const user = currentUser(c);
  const body = await c.req.json().catch(() => ({}));
  const pack = CREDIT_PACKS.find((p) => p.id === body.packId);
  if (!pack) return c.json({ error: "invalid_pack" }, 400);
  if (!pack.priceId) {
    console.error(`[paddle] pack "${pack.id}" has no PADDLE_PRICE_* configured`);
    return c.json({ error: "pack_not_configured" }, 500);
  }

  let txnId: string;
  try {
    const txn = await paddle().transactions.create({
      items: [{ priceId: pack.priceId, quantity: 1 }],
      // Echoed back on the webhook event so we know who/what to credit.
      customData: { userSub: user.sub, credits: String(pack.credits), packId: pack.id },
    });
    txnId = txn.id;
  } catch (e) {
    console.error("[paddle] transaction create failed:", e);
    return c.json({ error: "checkout_failed" }, 502);
  }

  const url = `${publicBaseUrl()}/credits/paddle?txn=${encodeURIComponent(txnId)}`;
  return c.json({ url });
});

// Hosted checkout page: loads Paddle.js and opens the overlay for the given transaction.
// The client token is public by design (it only permits opening checkouts).
paddleRoute.get("/credits/paddle", (c) => {
  const txn = c.req.query("txn") ?? "";
  const token = process.env.PADDLE_CLIENT_TOKEN ?? "";
  const successUrl = `${publicBaseUrl()}/credits/return?status=success`;
  // JSON.stringify keeps the values safely quoted inside the inline script.
  const cfg = {
    txn,
    token,
    successUrl,
    env: IS_PROD ? "production" : "sandbox",
  };
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>vibi</title>
<style>${brandPageStyles()} .msg{margin:0;font-size:14px;color:#9aa0aa}</style>
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script></head>
<body><div class="card">${brandHeader()}<p class="msg">Opening secure checkout…</p></div>
<script>
  var CFG = ${JSON.stringify(cfg)};
  if (CFG.env === "sandbox") Paddle.Environment.set("sandbox");
  Paddle.Initialize({ token: CFG.token });
  Paddle.Checkout.open({
    transactionId: CFG.txn,
    settings: { displayMode: "overlay", successUrl: CFG.successUrl },
  });
</script></body></html>`);
});

// Paddle calls this after payment. The signature is verified against the RAW body.
paddleRoute.post("/api/v2/paddle/webhook", async (c) => {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "webhook_not_configured" }, 500);
  const sig = c.req.header("paddle-signature");
  if (!sig) return c.json({ error: "missing_signature" }, 400);

  const raw = await c.req.text();
  let event;
  try {
    event = await paddle().webhooks.unmarshal(raw, secret, sig);
  } catch (e) {
    console.error("[paddle] signature verification failed:", e);
    return c.json({ error: "invalid_signature" }, 400);
  }
  if (!event) return c.json({ received: true });

  // transaction.completed fires once payment is settled — the point to grant credits.
  if (event.eventType === EventName.TransactionCompleted) {
    const data = event.data;
    const custom = (data.customData ?? {}) as Record<string, unknown>;
    const userSub = typeof custom.userSub === "string" ? custom.userSub : undefined;
    // Re-derive credits from the Price actually paid rather than trusting the echoed
    // customData — the catalog Price is the source of truth for how many credits a pack
    // grants. Fall back to customData only if no item matches (e.g. catalog drift).
    const paidPriceIds = (data.items ?? []).map((it) => it.price?.id).filter(Boolean);
    const pack = CREDIT_PACKS.find((p) => p.priceId && paidPriceIds.includes(p.priceId));
    const credits = pack?.credits ?? Number(custom.credits ?? 0);
    if (userSub && Number.isInteger(credits) && credits > 0) {
      // Idempotent on the transaction id — a redelivered webhook won't double-credit.
      await grantPurchase(userSub, credits, data.id);
      console.log(`[paddle] granted ${credits} credits to ${userSub} (txn ${data.id})`);
    } else {
      // Paid but uncreditable (missing userSub / unknown price) — must not be silently
      // dropped. Log loudly so it can be reconciled manually.
      console.error(
        `[paddle] TransactionCompleted ${data.id} could not be credited: userSub=${userSub} credits=${credits}`,
      );
    }
  }

  // A refund or chargeback claws back money — reverse the credits we granted so a user
  // can't keep them. Idempotent on the adjustment id (debitRefund's ledger ref).
  if (event.eventType === EventName.AdjustmentCreated) {
    const adj = event.data;
    if (adj.action === "refund" || adj.action === "chargeback") {
      const balance = await debitRefund(adj.transactionId, adj.id);
      if (balance === null) {
        console.warn(`[paddle] ${adj.action} ${adj.id} for txn ${adj.transactionId} — no recorded purchase to reverse`);
      } else {
        console.log(`[paddle] reversed credits for ${adj.action} ${adj.id} (txn ${adj.transactionId}); balance now ${balance}`);
      }
    }
  }
  return c.json({ received: true });
});

// Tiny landing page Paddle's checkout redirects to after a successful payment.
paddleRoute.get("/credits/return", (c) => {
  const status = c.req.query("status") ?? "success";
  const ok = status === "success";
  const msg = ok
    ? "Payment complete. Return to the plugin — your credits will appear shortly."
    : "Checkout canceled. You can return to the plugin.";
  const color = ok ? "#4fd18b" : "#ff7066";
  return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>vibi</title>
<style>${brandPageStyles()} .msg{margin:0;font-size:14px;color:${color}}</style></head>
<body><div class="card">${brandHeader()}<p class="msg">${msg}</p></div></body></html>`);
});
