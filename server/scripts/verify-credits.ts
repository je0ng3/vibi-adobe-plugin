// Throwaway runtime verification of the money path against a LOCAL Postgres.
// Recreates the existing Flyway-managed tables (with prod's real constraints, confirmed
// against Neon: credit_ledger.kind CHECK signup/consume/refund, credits>0, unique
// (kind,ref_id)) then drives the ACTUAL plugin functions. Run:
//   node --import tsx/esm scripts/verify-credits.ts
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/vibi_credit_test";
delete process.env.DATABASE_SSL;

const { query, getPool, ensureSchema } = await import("../src/db/pool.js");
const { ensureUser, getBalance, deduct, refund, grantPurchase, debitRefund } = await import(
  "../src/credit/creditStore.js"
);
const { createJob } = await import("../src/jobs/jobStore.js");
const { createDeviceCode, pollDeviceCode, authorizeUserCode, deleteExpiredDeviceCodes } = await import(
  "../src/auth/deviceStore.js"
);

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function ledgerCount(userId: string, kind: string, refId: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*) n FROM credit_ledger WHERE user_id=$1 AND kind=$2 AND ref_id=$3`,
    [userId, kind, refId],
  );
  return Number(r.rows[0].n);
}

async function setupExistingTables() {
  // Mirror the prod (Flyway) schema the plugin assumes but does not own.
  await query(`
    DROP TABLE IF EXISTS credit_ledger, user_credits, paddle_refunds, paddle_purchases, jobs, users CASCADE;
    CREATE TABLE users (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider     TEXT NOT NULL CHECK (provider IN ('google','apple')),
      provider_sub TEXT NOT NULL,
      email        TEXT,
      name         TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_sub)
    );
    CREATE TABLE user_credits (
      user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance    INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE credit_ledger (
      id         BIGSERIAL PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK (kind IN ('signup','consume','refund')),
      ref_id     TEXT NOT NULL,
      credits    INTEGER NOT NULL CHECK (credits > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (kind, ref_id)
    );
  `);
}

async function main() {
  await setupExistingTables();
  await ensureSchema(); // creates plugin-owned paddle_purchases, paddle_refunds, jobs (+idempotency_key)
  check("ensureSchema ran against prod-faithful schema", true);

  // 1. Signup bonus (idempotent)
  const uid = await ensureUser("google", "sub-1", "a@b.com", "Tester");
  check("signup bonus granted", (await getBalance(uid)) === 10, `balance=${await getBalance(uid)}`);
  const uid2 = await ensureUser("google", "sub-1", "a@b.com", "Tester");
  check("ensureUser idempotent (same uid)", uid === uid2);
  check("no double signup bonus", (await getBalance(uid)) === 10, `balance=${await getBalance(uid)}`);

  // 2. deduct idempotency on a stable key
  check("deduct #1 ok", (await deduct(uid, 3, "separation", "key-A")) === true);
  check("balance after deduct = 7", (await getBalance(uid)) === 7, `balance=${await getBalance(uid)}`);
  check("deduct replay (same key) returns true", (await deduct(uid, 3, "separation", "key-A")) === true);
  check("replay did NOT double-charge", (await getBalance(uid)) === 7, `balance=${await getBalance(uid)}`);

  // 3. insufficient funds — returns false, leaves NO phantom ledger row, no balance change
  check("deduct insufficient returns false", (await deduct(uid, 100, "separation", "key-B")) === false);
  check("balance unchanged after insufficient", (await getBalance(uid)) === 7, `balance=${await getBalance(uid)}`);
  check("no phantom ledger row for failed deduct", (await ledgerCount(uid, "consume", "key-B")) === 0);

  // 4. keyless deduct charges each time
  await deduct(uid, 2, "separation");
  await deduct(uid, 2, "separation");
  check("two keyless deducts both charged", (await getBalance(uid)) === 3, `balance=${await getBalance(uid)}`);

  // 5. job-failure refund (idempotent on ref)
  check("refund returns new balance 5", (await refund(uid, 2, "refund:job-1")) === 5);
  check("refund replay does not double-credit", (await refund(uid, 2, "refund:job-1")) === 5);
  check("balance after refund = 5", (await getBalance(uid)) === 5, `balance=${await getBalance(uid)}`);

  // 6. Paddle purchase (idempotent) then refund/chargeback (idempotent)
  check("grantPurchase -> 55", (await grantPurchase(uid, 50, "txn-1")) === 55);
  check("grantPurchase replay -> still 55", (await grantPurchase(uid, 50, "txn-1")) === 55);
  check("debitRefund -> 5", (await debitRefund("txn-1", "adj-1")) === 5);
  check("debitRefund replay -> still 5", (await debitRefund("txn-1", "adj-1")) === 5);
  check("debitRefund unknown txn -> null", (await debitRefund("txn-unknown", "adj-2")) === null);

  // 7. negative/non-integer guards
  let threw = false;
  try { await deduct(uid, -5, "x", "neg"); } catch { threw = true; }
  check("deduct rejects negative amount", threw);

  // 8. createJob idempotency
  const j1 = await createJob("separation", uid, "jobkey-1");
  check("createJob first -> created", j1.created === true);
  const j2 = await createJob("separation", uid, "jobkey-1");
  check("createJob retry -> not created", j2.created === false);
  check("createJob retry returns same job id", j1.job.id === j2.job.id, `${j1.job.id} vs ${j2.job.id}`);
  const j3 = await createJob("separation", uid);
  check("createJob keyless -> created", j3.created === true);

  // 9. CONCURRENCY: no double-spend, no oversell, idempotent under races.
  const cu = await ensureUser("google", "sub-concurrency", "c@b.com", "Conc");
  // start from a known balance of 5
  await query(`UPDATE user_credits SET balance = 5 WHERE user_id = $1`, [cu]);
  // 10 concurrent 1-credit deducts, each a distinct key → at most 5 may succeed, never overdraw.
  const races = await Promise.all(
    Array.from({ length: 10 }, (_, i) => deduct(cu, 1, "race", `race-${i}`)),
  );
  const ok = races.filter(Boolean).length;
  check("concurrent deducts: exactly 5 succeeded (no oversell)", ok === 5, `succeeded=${ok}`);
  check("concurrent deducts: balance landed at 0 (never negative)", (await getBalance(cu)) === 0, `balance=${await getBalance(cu)}`);

  // 10 concurrent deducts with the SAME key against a fresh balance → charge exactly once.
  await query(`UPDATE user_credits SET balance = 5 WHERE user_id = $1`, [cu]);
  await Promise.all(Array.from({ length: 10 }, () => deduct(cu, 1, "race", "same-key")));
  check("concurrent same-key deducts charge once", (await getBalance(cu)) === 4, `balance=${await getBalance(cu)}`);

  // 11. DEVICE STORE persistence (Postgres-backed): an authorization written by one call
  // must be visible to a later poll — i.e. survives across requests / a restart / instances.
  const dc = await createDeviceCode();
  check("createDeviceCode returns pending", dc.status === "pending" && !!dc.deviceCode && !!dc.userCode);
  const p1 = await pollDeviceCode(dc.deviceCode);
  check("poll sees pending, no user", p1?.status === "pending" && !p1?.user);
  const authed = await authorizeUserCode(dc.userCode, { sub: uid, email: "a@b.com", name: "Tester" });
  check("authorize sets authorized", authed?.status === "authorized" && authed?.user?.sub === uid);
  const p2 = await pollDeviceCode(dc.deviceCode);
  check("poll AFTER authorize sees authorized + user (persisted)", p2?.status === "authorized" && p2?.user?.sub === uid);
  check("poll unknown device code -> null", (await pollDeviceCode("nope")) === null);
  check("authorize unknown user code -> null", (await authorizeUserCode("ZZZZZZZZ", { sub: uid, email: "", name: "" })) === null);

  // expiry: backdate created_at past the 10-min TTL.
  const old = await createDeviceCode();
  await query(`UPDATE device_codes SET created_at = now() - interval '20 minutes' WHERE device_code = $1`, [old.deviceCode]);
  check("expired code polls as expired", (await pollDeviceCode(old.deviceCode))?.status === "expired");
  check("expired code can't be authorized", (await authorizeUserCode(old.userCode, { sub: uid, email: "", name: "" }))?.status === "expired");
  const purged = await deleteExpiredDeviceCodes();
  check("cleanup removes expired device code(s)", purged >= 1, `purged=${purged}`);
  check("non-expired code survives cleanup", (await pollDeviceCode(dc.deviceCode)) !== null);

  console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} FAILURE(S) ❌`}`);
  await getPool().end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("harness error:", e);
  process.exit(2);
});
