import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 (S3-compatible) object store + SigV4 presigned URL 발급.
 * vibi-bff 의 `ObjectStore.kt` 를 Node 로 포팅한 것 — 동일한 동기/계약을 맞춤.
 *
 * 큰 산출물(separation stem, dub audio)을 R2 에 업로드 후 presigned GET URL 로 302 redirect 해
 * 이 서버가 바이트 전송으로 잠기지 않게 한다. **R2 는 egress 무료** 라 어느 호스트에서든
 * 아웃바운드 전송 비용이 0 으로 떨어짐 — R2 이주의 핵심 이유.
 *
 * 인증: R2 API token 의 access key + secret (Cloudflare dashboard → R2 → Manage API Tokens,
 * Object Read & Write). account ID 는 dashboard URL 의 32자 hex.
 *
 * 미설정(`R2_BUCKET` blank) 시 [objectStore] 가 null — 호출부가 기존 streaming fallback 사용.
 */

// HEAD object 가 "없음" 으로 반환할 수 있는 status code. R2 는 token 권한에 따라 404(NoSuchKey)
// 또는 403 으로 응답 가능. 권한이 진짜 부족하면 PUT 에서 throw 하므로 둘 다 miss 로 간주해도 안전.
const MISSING_KEY_STATUS = new Set([403, 404]);

export interface SignedUrlOptions {
  ttlSec?: number;
  downloadFilename?: string;
  contentType?: string;
  /** true → Content-Disposition inline (브라우저/플레이어 인라인 재생), false → attachment. */
  inline?: boolean;
}

export class ObjectStore {
  // 같은 프로세스가 같은 objectKey 를 반복 다운로드 처리할 때 R2 HEAD RPC 도 0회로.
  private readonly uploadedKeys = new Map<string, number>();

  constructor(
    private readonly bucket: string,
    private readonly client: S3Client,
    readonly defaultTtlSec: number,
  ) {}

  /**
   * R2 가 객체를 갖고 있지 않으면 [filePath] 를 업로드. 멱등.
   * @returns 호출 후 객체가 R2 에 존재하면 true. 로컬 파일도 없고 R2 에도 없으면 false
   *          (호출부 → 404). 이렇게 boolean 으로 돌려 기존 라우트의 404 시맨틱을 보존한다.
   */
  async uploadIfAbsent(objectKey: string, filePath: string, contentType: string): Promise<boolean> {
    let fileSize = -1;
    try {
      fileSize = (await stat(filePath)).size;
    } catch {
      fileSize = -1;
    }
    const fileExists = fileSize >= 0;

    // Hot path: 이 프로세스에서 이미 올린 객체면 R2 HEAD 도 skip.
    const cached = this.uploadedKeys.get(objectKey);
    if (cached != null && (!fileExists || cached === fileSize)) return true;

    const existing = await this.headLength(objectKey);
    if (existing >= 0 && (!fileExists || existing === fileSize)) {
      // R2 가 갖고 있고 (로컬 없거나 같은 크기) — 업로드 skip.
      this.uploadedKeys.set(objectKey, existing);
      return true;
    }
    if (!fileExists) {
      // R2 도 없고 로컬도 없음 — 진짜 데이터 없음 (대개 cleanup 으로 디스크 정리된 옛 잡).
      return false;
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        // 스트림 업로드 + 명시적 ContentLength → 전체 바이트를 RAM 에 올리지 않음.
        Body: createReadStream(filePath),
        ContentLength: fileSize,
        ContentType: contentType,
      }),
    );
    this.uploadedKeys.set(objectKey, fileSize);
    console.log(`[objectStore] uploaded r2://${this.bucket}/${objectKey} (${fileSize} bytes)`);
    return true;
  }

  /** SigV4 presigned GET URL. ttl 미지정 시 [defaultTtlSec]. */
  async signedUrl(objectKey: string, opts: SignedUrlOptions = {}): Promise<string> {
    const ttl = opts.ttlSec ?? this.defaultTtlSec;
    // S3/R2 spec: response-content-disposition / -type 은 presigned query param 으로만 전달 가능
    // (request header 가 아님) — URL 만으로 다운로드 파일명/타입을 강제하기 위함.
    const disposition = opts.downloadFilename
      ? `${opts.inline ? "inline" : "attachment"}; filename="${opts.downloadFilename}"`
      : undefined;
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: disposition,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: ttl });
  }

  /**
   * Delete every object under [prefix] (e.g. `separation/<jobId>/`). Used to purge a separation's
   * stems from R2 when its history record is removed. Paginates + batch-deletes; idempotent (a
   * missing prefix is a no-op). Also drops any matching hot-path cache entries.
   */
  async deletePrefix(prefix: string): Promise<void> {
    let token: string | undefined;
    do {
      const list = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (list.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
      if (keys.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        for (const k of keys) this.uploadedKeys.delete(k);
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }

  private async headLength(objectKey: string): Promise<number> {
    try {
      const r = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      return r.ContentLength ?? -1;
    } catch (e: unknown) {
      const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      const name = (e as { name?: string })?.name;
      if (name === "NotFound" || (typeof status === "number" && MISSING_KEY_STATUS.has(status))) {
        return -1;
      }
      throw e;
    }
  }
}

function buildObjectStore(): ObjectStore | null {
  const bucket = (process.env.R2_BUCKET ?? "").trim();
  if (!bucket) {
    console.log("[objectStore] R2_BUCKET blank — serving stems via streaming fallback");
    return null;
  }

  // R2 활성 시 자격증명 3종은 필수 — 누락이면 startup fail-fast (bff requireNotNull 과 동일 의도).
  const accountId = requireEnv("R2_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");

  const ttl = Number(process.env.SIGNED_URL_TTL_SEC ?? 3600);
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86_400) {
    throw new Error(`SIGNED_URL_TTL_SEC must be in 60..86400 (got ${process.env.SIGNED_URL_TTL_SEC})`);
  }

  const client = new S3Client({
    // R2 는 단일 글로벌 namespace — region 은 "auto" placeholder (SDK 가 빈 region 거부).
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  console.log(`[objectStore] R2 enabled: bucket=${bucket} ttl=${ttl}s`);
  return new ObjectStore(bucket, client, ttl);
}

function requireEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) throw new Error(`${name} required when R2_BUCKET is set`);
  return v;
}

/** 프로세스 단일 인스턴스. R2 미설정이면 null → 라우트가 streaming fallback. */
export const objectStore: ObjectStore | null = buildObjectStore();
