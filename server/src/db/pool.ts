import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  pool = new Pool({
    connectionString,
    // Supabase/Neon and most managed Postgres require TLS. Verify the server certificate
    // (Neon's is publicly-trusted) so the money/identity traffic can't be MITM'd; only
    // skip verification when explicitly opted in for a self-signed/dev endpoint.
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: process.env.DATABASE_SSL_NO_VERIFY !== "true" }
        : undefined,
    // Bound the pool and kill runaway queries / leaked transactions so a webhook or retry
    // storm can't pin connections indefinitely.
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // Neon bills compute whenever it's awake, so the pool must go fully quiet when idle.
    // node-postgres keeps no minimum and (with TCP keepAlive off, the default) sends no idle
    // keepalive pings, so a 30s idleTimeout drains every connection 30s after the last query —
    // then nothing touches the DB and Neon can autosuspend. Do NOT add `keepAlive: true` or a
    // min-pool here, and keep the cleanup sweep idle interval long (see jobs/cleanup.ts), or
    // the DB never suspends and the free compute allowance is burned 24/7.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000),
    idle_in_transaction_session_timeout: 30_000,
  });
  // node-postgres emits 'error' on the Pool when an IDLE backend connection drops (server
  // restart, network blip). With no listener that event is thrown and crashes the process —
  // a swallow-and-log listener keeps the pool alive; the next query just reconnects.
  pool.on("error", (err) => console.error("[pg] idle client error:", err));
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never);
}

/**
 * Run a function inside a transaction. The callback receives a dedicated client;
 * the transaction commits on success and rolls back on any thrown error.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Idempotent bootstrap for the PLUGIN-OWNED tables only. Identity and credit balances
 * live in the existing Flyway-managed schema (users / user_credits / credit_ledger /
 * credit_transactions), which this server must NOT recreate or alter. We only add the
 * additive tables this plugin needs: its generic job queue and Paddle purchase records.
 * These should eventually be promoted into proper Flyway migrations.
 */
export async function ensureSchema(): Promise<void> {
  await query(`
    -- Paddle top-ups (the existing credit_transactions.platform CHECK excludes paddle,
    -- and credit_ledger.kind only allows signup/consume/refund — so neither existing table
    -- can hold a Paddle credit. These plugin-owned tables are the audit record instead).
    CREATE TABLE IF NOT EXISTS paddle_purchases (
      txn_id     TEXT PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credits    INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Paddle refunds/chargebacks. PK on the Paddle adjustment id makes credit clawback
    -- idempotent against redelivered webhooks. txn_id links back to the original purchase.
    CREATE TABLE IF NOT EXISTS paddle_refunds (
      adjustment_id TEXT PRIMARY KEY,
      txn_id        TEXT NOT NULL,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credits       INTEGER NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Device-authorization flow state. Postgres-backed (not in-memory) so a server restart
    -- or redeploy mid-sign-in doesn't drop the pending code, and it survives >1 instance.
    CREATE TABLE IF NOT EXISTS device_codes (
      device_code TEXT PRIMARY KEY,
      user_code   TEXT NOT NULL UNIQUE,
      status      TEXT NOT NULL DEFAULT 'pending',
      user_sub    TEXT,
      user_email  TEXT,
      user_name   TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      owner_sub       TEXT NOT NULL,
      status          TEXT NOT NULL,
      progress        INTEGER NOT NULL DEFAULT 0,
      progress_reason TEXT,
      result          JSONB,
      error           TEXT,
      idempotency_key TEXT,
      -- Separation history: the Premiere project a job belongs to, plus enough metadata to
      -- render the restored card (name / size / duration) without the original audio.
      project_id      TEXT,
      file_name       TEXT,
      byte_length     BIGINT,
      duration_ms     INTEGER,
      -- Credits charged up-front for this job. Persisted so an interrupted job can be refunded
      -- on restart (the in-memory BillingRef dies with the process — see failStaleJobs).
      cost            INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Existing deployments: add the columns if the table predates them.
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project_id  TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS file_name   TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS byte_length BIGINT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost        INTEGER;
    CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at);
    -- Lists a user's saved separations for the open project, newest first.
    CREATE INDEX IF NOT EXISTS jobs_history_idx ON jobs (owner_sub, project_id, kind, status, created_at);
    -- Idempotency is scoped PER OWNER: the Idempotency-Key is only client-unique, so a global
    -- unique index let two different users' keys collide (one user's retry would resolve to the
    -- other's job, or fall through and duplicate work). Composite (owner_sub, idempotency_key)
    -- isolates each user. Multiple NULLs are allowed, so key-less submits are unaffected.
    -- Relaxation of the old global index, so no existing row can violate it. Drop the old one.
    DROP INDEX IF EXISTS jobs_idempotency_key_idx;
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_owner_idempotency_key_idx
      ON jobs (owner_sub, idempotency_key);
  `);
}
