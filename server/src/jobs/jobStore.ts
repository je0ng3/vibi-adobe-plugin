import { randomUUID } from "node:crypto";
import { query } from "../db/pool.js";

export type JobKind = "separation";
export type JobStatus = "queued" | "processing" | "ready" | "failed";

export interface Job<T = unknown> {
  id: string;
  kind: JobKind;
  ownerSub: string;
  status: JobStatus;
  progress: number;
  progressReason?: string;
  result?: T;
  error?: string;
  createdAt: number;
}

interface JobRow {
  id: string;
  kind: JobKind;
  owner_sub: string;
  status: JobStatus;
  progress: number;
  progress_reason: string | null;
  result: unknown;
  error: string | null;
  created_at: Date;
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    ownerSub: r.owner_sub,
    status: r.status,
    progress: r.progress,
    progressReason: r.progress_reason ?? undefined,
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.created_at.getTime(),
  };
}

/**
 * Create a job, or — when an `idempotencyKey` is supplied and a job already exists for it
 * (a retried submit) — return that existing job. `created` tells the caller whether to kick
 * off the work: on a retry it's false, so the route must NOT start a second Perso job.
 */
export async function createJob(
  kind: JobKind,
  ownerSub: string,
  idempotencyKey?: string,
): Promise<{ job: Job; created: boolean }> {
  const id = `${kind.slice(0, 3)}-${randomUUID()}`;
  if (idempotencyKey) {
    const ins = await query<JobRow>(
      `INSERT INTO jobs (id, kind, owner_sub, status, progress, idempotency_key)
       VALUES ($1, $2, $3, 'queued', 0, $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [id, kind, ownerSub, idempotencyKey],
    );
    if (ins.rows[0]) return { job: rowToJob(ins.rows[0]), created: true };
    // Conflict: a prior request already created this job. Return it (scoped to owner).
    const existing = await query<JobRow>(
      `SELECT * FROM jobs WHERE idempotency_key = $1 AND owner_sub = $2`,
      [idempotencyKey, ownerSub],
    );
    if (existing.rows[0]) return { job: rowToJob(existing.rows[0]), created: false };
  }
  await query(
    `INSERT INTO jobs (id, kind, owner_sub, status, progress) VALUES ($1, $2, $3, 'queued', 0)`,
    [id, kind, ownerSub],
  );
  return { job: { id, kind, ownerSub, status: "queued", progress: 0, createdAt: Date.now() }, created: true };
}

export async function getJob(id: string): Promise<Job | undefined> {
  if (!id) return undefined;
  const res = await query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return res.rows[0] ? rowToJob(res.rows[0]) : undefined;
}

export async function updateJob(id: string, patch: Partial<Job>): Promise<void> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  let i = 2;
  if (patch.status !== undefined) { sets.push(`status = $${i++}`); params.push(patch.status); }
  if (patch.progress !== undefined) { sets.push(`progress = $${i++}`); params.push(patch.progress); }
  if (patch.progressReason !== undefined) { sets.push(`progress_reason = $${i++}`); params.push(patch.progressReason); }
  if (patch.error !== undefined) { sets.push(`error = $${i++}`); params.push(patch.error); }
  if (patch.result !== undefined) { sets.push(`result = $${i++}`); params.push(JSON.stringify(patch.result)); }
  await query(`UPDATE jobs SET ${sets.join(", ")} WHERE id = $1`, params);
}

/**
 * On startup, mark any job still left mid-flight ("queued"/"processing") as failed: its driving
 * promise died with the previous process, so it would otherwise poll forever. Returns the count
 * marked. (Credits aren't auto-refunded here — the cost isn't persisted on the row — so a restart
 * mid-job is a known gap; restarts on the single instance are rare.)
 */
export async function failStaleJobs(): Promise<number> {
  const res = await query(
    `UPDATE jobs SET status = 'failed', error = 'interrupted by server restart', updated_at = now()
     WHERE status IN ('queued', 'processing')`,
  );
  return res.rowCount ?? 0;
}

/** Delete jobs older than the cutoff; returns the ids removed so callers can drop their stems. */
export async function deleteJobsOlderThan(maxAgeMs: number): Promise<string[]> {
  const res = await query<{ id: string }>(
    `DELETE FROM jobs WHERE created_at < now() - ($1 || ' milliseconds')::interval RETURNING id`,
    [String(maxAgeMs)],
  );
  return res.rows.map((r) => r.id);
}
