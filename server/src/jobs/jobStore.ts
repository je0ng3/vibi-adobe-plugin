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
  projectId?: string;
  fileName?: string;
  byteLength?: number;
  durationMs?: number;
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
  project_id: string | null;
  file_name: string | null;
  byte_length: string | number | null; // BIGINT comes back as a string from node-postgres
  duration_ms: number | null;
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
    projectId: r.project_id ?? undefined,
    fileName: r.file_name ?? undefined,
    byteLength: r.byte_length != null ? Number(r.byte_length) : undefined,
    durationMs: r.duration_ms ?? undefined,
    createdAt: r.created_at.getTime(),
  };
}

/** Metadata persisted with a job so its separation history card can be rebuilt later. */
export interface JobMeta {
  idempotencyKey?: string;
  projectId?: string | null;
  fileName?: string | null;
  byteLength?: number | null;
  durationMs?: number | null;
}

/**
 * Create a job, or — when an `idempotencyKey` is supplied and a job already exists for it
 * (a retried submit) — return that existing job. `created` tells the caller whether to kick
 * off the work: on a retry it's false, so the route must NOT start a second Perso job.
 */
export async function createJob(
  kind: JobKind,
  ownerSub: string,
  meta: JobMeta = {},
): Promise<{ job: Job; created: boolean }> {
  const id = `${kind.slice(0, 3)}-${randomUUID()}`;
  const { idempotencyKey, projectId = null, fileName = null, byteLength = null, durationMs = null } = meta;
  const cols = "id, kind, owner_sub, status, progress, project_id, file_name, byte_length, duration_ms";
  const baseVals = [id, kind, ownerSub, projectId, fileName, byteLength, durationMs];
  if (idempotencyKey) {
    const ins = await query<JobRow>(
      `INSERT INTO jobs (${cols}, idempotency_key)
       VALUES ($1, $2, $3, 'queued', 0, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [...baseVals, idempotencyKey],
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
    `INSERT INTO jobs (${cols}) VALUES ($1, $2, $3, 'queued', 0, $4, $5, $6, $7)`,
    baseVals,
  );
  return {
    job: {
      id,
      kind,
      ownerSub,
      status: "queued",
      progress: 0,
      projectId: projectId ?? undefined,
      fileName: fileName ?? undefined,
      byteLength: byteLength ?? undefined,
      durationMs: durationMs ?? undefined,
      createdAt: Date.now(),
    },
    created: true,
  };
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

// Shape of a separation job's stored result (mirrors separationJob.ts SeparationResult).
// Declared locally to keep jobStore free of a runtime import from the job runner.
interface SeparationResultLike {
  stems?: { stemId: string; label: string }[];
  projectSeq?: number | null;
}

/** One saved separation as the history list/restore needs it (no stem bytes). */
export interface SeparationSummary {
  jobId: string;
  fileName: string | null;
  byteLength: number | null;
  durationMs: number | null;
  createdAt: number;
  stems: { stemId: string; label: string }[];
  hasScript: boolean;
}

/** A user's ready separations for one project, newest first — the panel's restore list. */
export async function listReadySeparations(
  ownerSub: string,
  projectId: string | null,
): Promise<SeparationSummary[]> {
  // `IS NOT DISTINCT FROM` so a NULL projectId matches NULL rows (null-safe equality).
  const res = await query<JobRow>(
    `SELECT * FROM jobs
     WHERE kind = 'separation' AND status = 'ready' AND owner_sub = $1
       AND project_id IS NOT DISTINCT FROM $2
     ORDER BY created_at DESC`,
    [ownerSub, projectId],
  );
  return res.rows.map((r) => {
    const result = (r.result ?? {}) as SeparationResultLike;
    return {
      jobId: r.id,
      fileName: r.file_name,
      byteLength: r.byte_length != null ? Number(r.byte_length) : null,
      durationMs: r.duration_ms,
      createdAt: r.created_at.getTime(),
      stems: result.stems ?? [],
      hasScript: result.projectSeq != null,
    };
  });
}

/** Delete a single job by id, scoped to its owner. Returns true if a row was removed. */
export async function deleteJob(id: string, ownerSub: string): Promise<boolean> {
  const res = await query(`DELETE FROM jobs WHERE id = $1 AND owner_sub = $2`, [id, ownerSub]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Delete non-ready jobs (failed / interrupted / never-finished) older than the cutoff. Ready
 * separations are NOT touched here — they're durable history, governed by the retention below.
 * Returns the ids removed so the caller can drop their on-disk + R2 stems.
 */
export async function deleteStaleNonReadyJobs(maxAgeMs: number): Promise<string[]> {
  const res = await query<{ id: string }>(
    `DELETE FROM jobs
     WHERE status <> 'ready' AND created_at < now() - ($1 || ' milliseconds')::interval
     RETURNING id`,
    [String(maxAgeMs)],
  );
  return res.rows.map((r) => r.id);
}

/** Delete ready separation history older than the (long) retention cutoff. */
export async function deleteExpiredHistory(maxAgeMs: number): Promise<string[]> {
  const res = await query<{ id: string }>(
    `DELETE FROM jobs
     WHERE kind = 'separation' AND status = 'ready'
       AND created_at < now() - ($1 || ' milliseconds')::interval
     RETURNING id`,
    [String(maxAgeMs)],
  );
  return res.rows.map((r) => r.id);
}

/**
 * Bound history growth: per (owner, project) keep only the newest `keepPerProject` ready
 * separations, deleting the rest. Returns the ids removed so their stems can be purged.
 */
export async function pruneHistoryOverLimit(keepPerProject: number): Promise<string[]> {
  const res = await query<{ id: string }>(
    `DELETE FROM jobs WHERE id IN (
       SELECT id FROM (
         SELECT id, row_number() OVER (
           PARTITION BY owner_sub, COALESCE(project_id, '')
           ORDER BY created_at DESC
         ) AS rn
         FROM jobs WHERE kind = 'separation' AND status = 'ready'
       ) ranked WHERE ranked.rn > $1
     ) RETURNING id`,
    [keepPerProject],
  );
  return res.rows.map((r) => r.id);
}
