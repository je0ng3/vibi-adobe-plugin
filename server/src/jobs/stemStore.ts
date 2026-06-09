import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

// Stems are large binary blobs — keep them on disk (not in RAM or Postgres) so the
// process footprint stays bounded and they survive a restart while a job is still fresh.
const STEM_DIR = process.env.STEM_DIR
  ? resolve(process.env.STEM_DIR)
  : resolve(process.cwd(), ".data", "stems");

// jobId is server-generated (`sep-<uuid>`), but stemId / lang reach getStemBytes straight
// from URL params (`/separate/:jobId/stem/:stemId`, `/dub/:jobId/audio/:lang`). Reject anything
// outside [A-Za-z0-9_-] so a value like `../../../etc/secret` can't traverse out of STEM_DIR
// (and can't be reflected into the Content-Disposition filename). Throwing here surfaces as a
// 404 on reads (getStemBytes catches) and as a hard error on writes (which only ever get
// server-generated ids).
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function assertSafeId(id: string, label: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`unsafe ${label}: ${id}`);
}

function jobDir(jobId: string): string {
  assertSafeId(jobId, "jobId");
  return join(STEM_DIR, jobId);
}

function stemPath(jobId: string, stemId: string): string {
  assertSafeId(stemId, "stemId");
  return join(jobDir(jobId), `${stemId}.wav`);
}

// Absolute on-disk path of a stem. Exposed so the R2 object store can stream the file
// straight to the bucket (avoiding a full ArrayBuffer load into RAM) on the download path.
export function stemFilePath(jobId: string, stemId: string): string {
  return stemPath(jobId, stemId);
}

export async function putStemBytes(
  jobId: string,
  stemId: string,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  await mkdir(jobDir(jobId), { recursive: true });
  await writeFile(stemPath(jobId, stemId), bytes instanceof Uint8Array ? bytes : Buffer.from(bytes));
}

export async function getStemBytes(jobId: string, stemId: string): Promise<ArrayBuffer | undefined> {
  try {
    const buf = await readFile(stemPath(jobId, stemId));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    return undefined;
  }
}

export async function deleteStemsForJob(jobId: string): Promise<void> {
  await rm(jobDir(jobId), { recursive: true, force: true }).catch(() => {});
}
