import { randomUUID } from "node:crypto";
import { query, withTransaction } from "../db/pool.js";

const SIGNUP_BONUS_CREDITS = Number(process.env.SIGNUP_BONUS_CREDITS ?? 10);

export type Provider = "google" | "apple";

/**
 * Identifies who to refund and how much when a paid job fails. Routes charge credits
 * up-front and pass this into the job runner so the catch path can refund (idempotent
 * via the ledger ref `refund:<jobId>`).
 */
export interface BillingRef {
  ownerSub: string;
  cost: number;
}

/**
 * Find-or-create the user in the EXISTING (Flyway-managed) `users` table, keyed by
 * (provider, provider_sub), and ensure a `user_credits` row exists. New users receive
 * the signup bonus exactly once (credit_ledger's unique (kind, ref_id) makes it
 * idempotent across calls/restarts). Returns the internal uuid — that id is what the
 * rest of the app uses as the identity (carried in the JWT `sub`), so every downstream
 * credit/job row references users(id) correctly.
 */
export async function ensureUser(
  provider: Provider,
  providerSub: string,
  email: string,
  name: string,
): Promise<string> {
  return withTransaction(async (client) => {
    const upsert = await client.query<{ id: string; is_new: boolean }>(
      `INSERT INTO users (id, provider, provider_sub, email, name)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)
       ON CONFLICT (provider, provider_sub)
       DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, updated_at = now()
       RETURNING id, (xmax = 0) AS is_new`,
      [provider, providerSub, email, name],
    );
    const { id, is_new } = upsert.rows[0];

    const bonus = is_new ? Math.max(0, SIGNUP_BONUS_CREDITS) : 0;
    await client.query(
      `INSERT INTO user_credits (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [id, bonus],
    );
    if (bonus > 0) {
      // credit_ledger records the bonus; unique (kind, ref_id) keeps it idempotent.
      await client.query(
        `INSERT INTO credit_ledger (user_id, kind, ref_id, credits) VALUES ($1, 'signup', $2, $3)
         ON CONFLICT (kind, ref_id) DO NOTHING`,
        [id, `signup:${id}`, bonus],
      );
    }
    return id;
  });
}

export async function getBalance(userId: string): Promise<number> {
  const res = await query<{ balance: number }>(
    `SELECT balance FROM user_credits WHERE user_id = $1`,
    [userId],
  );
  return res.rows[0]?.balance ?? 0;
}

// Sentinel for "the user can't afford this" so the transaction rolls back the ledger claim
// below; deduct() catches it and returns false rather than propagating an error.
class InsufficientFunds extends Error {}

/**
 * Atomically consume `amount` credits. Returns true if the user had enough.
 *
 * Idempotent on `ref`: pass a stable idempotency key and a retried submit charges exactly
 * once (the unique credit_ledger (kind, ref_id) makes the second attempt a no-op that still
 * returns true). We claim the ledger row FIRST, then deduct — so a replay is detected before
 * any balance change, and an insufficient balance rolls the claim back via InsufficientFunds.
 * With no `ref` a random one is generated (NOT idempotent — callers wanting retry-safety
 * must supply a key).
 */
export async function deduct(
  userId: string,
  amount: number,
  _reason = "consume",
  ref?: string,
): Promise<boolean> {
  // Guard the money primitive: a negative amount would *increase* the balance while
  // trivially satisfying `balance >= amount` (a free top-up); non-integers corrupt it.
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`deduct: amount must be a positive integer, got ${amount}`);
  }
  const refId = ref ?? randomUUID();
  try {
    return await withTransaction(async (client) => {
      const claim = await client.query(
        `INSERT INTO credit_ledger (user_id, kind, ref_id, credits) VALUES ($1, 'consume', $2, $3)
         ON CONFLICT (kind, ref_id) DO NOTHING
         RETURNING id`,
        [userId, refId, amount],
      );
      if (claim.rowCount === 0) return true; // replay of a prior (retried) request — already charged.
      const res = await client.query(
        `UPDATE user_credits SET balance = balance - $2, updated_at = now()
         WHERE user_id = $1 AND balance >= $2
         RETURNING balance`,
        [userId, amount],
      );
      if (res.rowCount === 0) throw new InsufficientFunds();
      return true;
    });
  } catch (e) {
    if (e instanceof InsufficientFunds) return false;
    throw e;
  }
}

/**
 * Refund `amount` credits for a previously-consumed job. Idempotent on `ref` — a retried
 * refund won't double-credit (credit_ledger unique on (kind, ref_id)). Returns the new balance.
 */
export async function refund(userId: string, amount: number, ref: string): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`refund: amount must be a positive integer, got ${amount}`);
  }
  return withTransaction(async (client) => {
    const ledger = await client.query(
      `INSERT INTO credit_ledger (user_id, kind, ref_id, credits) VALUES ($1, 'refund', $2, $3)
       ON CONFLICT (kind, ref_id) DO NOTHING
       RETURNING id`,
      [userId, ref, amount],
    );
    if (ledger.rowCount === 0) {
      const cur = await client.query<{ balance: number }>(
        `SELECT balance FROM user_credits WHERE user_id = $1`,
        [userId],
      );
      return cur.rows[0]?.balance ?? 0;
    }
    const res = await client.query<{ balance: number }>(
      `INSERT INTO user_credits (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance + $2, updated_at = now()
       RETURNING balance`,
      [userId, amount],
    );
    return res.rows[0]?.balance ?? 0;
  });
}

/**
 * Credit a completed Paddle purchase. Recorded in the plugin-owned `paddle_purchases`
 * table (the existing `credit_transactions.platform` CHECK only allows apple/google/admin,
 * so Paddle top-ups can't live there). We deliberately do NOT mirror this into
 * `credit_ledger`: that table's kind CHECK only permits signup/consume/refund, so a
 * 'purchase' row would violate the constraint and roll back the whole grant — leaving a
 * paid user with zero credits. `paddle_purchases` IS the audit record for top-ups.
 * Idempotent on the Paddle transaction id (paddle_purchases.txn_id PK), so a redelivered
 * webhook can't double-credit. Returns the new balance.
 */
export async function grantPurchase(
  userId: string,
  credits: number,
  paddleTxnId: string,
): Promise<number> {
  if (!Number.isInteger(credits) || credits <= 0) {
    throw new Error(`grantPurchase: credits must be a positive integer, got ${credits}`);
  }
  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO paddle_purchases (txn_id, user_id, credits) VALUES ($1, $2, $3)
       ON CONFLICT (txn_id) DO NOTHING
       RETURNING txn_id`,
      [paddleTxnId, userId, credits],
    );
    if (inserted.rowCount === 0) {
      const cur = await client.query<{ balance: number }>(
        `SELECT balance FROM user_credits WHERE user_id = $1`,
        [userId],
      );
      return cur.rows[0]?.balance ?? 0;
    }
    const res = await client.query<{ balance: number }>(
      `INSERT INTO user_credits (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance + $2, updated_at = now()
       RETURNING balance`,
      [userId, credits],
    );
    return res.rows[0]?.balance ?? 0;
  });
}

/**
 * Reverse a Paddle purchase when the customer is refunded or charges back. Looks up the
 * original `paddle_purchases` row by transaction id to find who/how-many to debit, records
 * the clawback in the plugin-owned `paddle_refunds` table (idempotent on the Paddle
 * adjustment id — credit_ledger can't hold this, its kind CHECK only allows
 * signup/consume/refund), and subtracts the credits. The balance is allowed to go negative:
 * that's honest accounting and blocks further spend until the user buys again, which deters
 * refund-and-keep-credits fraud. Returns the new balance, or null if no matching purchase
 * was recorded.
 */
export async function debitRefund(paddleTxnId: string, adjustmentId: string): Promise<number | null> {
  return withTransaction(async (client) => {
    const purchase = await client.query<{ user_id: string; credits: number }>(
      `SELECT user_id, credits FROM paddle_purchases WHERE txn_id = $1`,
      [paddleTxnId],
    );
    const row = purchase.rows[0];
    if (!row) return null; // refund for a transaction we never credited — nothing to reverse.

    const recorded = await client.query(
      `INSERT INTO paddle_refunds (adjustment_id, txn_id, user_id, credits) VALUES ($1, $2, $3, $4)
       ON CONFLICT (adjustment_id) DO NOTHING
       RETURNING adjustment_id`,
      [adjustmentId, paddleTxnId, row.user_id, row.credits],
    );
    if (recorded.rowCount === 0) {
      const cur = await client.query<{ balance: number }>(
        `SELECT balance FROM user_credits WHERE user_id = $1`,
        [row.user_id],
      );
      return cur.rows[0]?.balance ?? 0;
    }
    const res = await client.query<{ balance: number }>(
      `UPDATE user_credits SET balance = balance - $2, updated_at = now()
       WHERE user_id = $1 RETURNING balance`,
      [row.user_id, row.credits],
    );
    return res.rows[0]?.balance ?? 0;
  });
}

export function creditsForDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.max(1, Math.ceil(durationMs / 60_000));
}
