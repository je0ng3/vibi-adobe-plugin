export const PERSO_API_BASE = process.env.PERSO_API_BASE ?? "https://api.perso.ai";
export const PERSO_STORAGE_BASE = process.env.PERSO_STORAGE_BASE ?? "https://portal-media.perso.ai";

const ALLOWED_DOWNLOAD_HOSTS = new Set<string>(["api.perso.ai", "portal-media.perso.ai"]);

export function resolveDownloadUrl(downloadUrl: string): { url: string; needsAuth: boolean } {
  if (!downloadUrl || downloadUrl.trim().length === 0) {
    throw new Error("downloadUrl must not be blank");
  }
  if (downloadUrl.startsWith("//") || downloadUrl.startsWith("\\")) {
    throw new Error(`protocol-relative downloadUrl rejected: ${downloadUrl}`);
  }
  let absUrl: string;
  if (downloadUrl.startsWith("http://") || downloadUrl.startsWith("https://")) {
    absUrl = downloadUrl;
  } else if (downloadUrl.startsWith("/perso-storage/")) {
    absUrl = `${PERSO_STORAGE_BASE}${downloadUrl}`;
  } else if (downloadUrl.startsWith("/")) {
    absUrl = `${PERSO_API_BASE}${downloadUrl}`;
  } else {
    absUrl = `${PERSO_API_BASE}/${downloadUrl}`;
  }
  const host = new URL(absUrl).host.toLowerCase();
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) {
    throw new Error(`downloadUrl host '${host}' not allowed: ${downloadUrl}`);
  }
  const needsAuth = !downloadUrl.startsWith("http") && !downloadUrl.startsWith("/perso-storage/");
  return { url: absUrl, needsAuth };
}

export function persoApiKey(): string {
  const key = process.env.PERSO_API_KEY;
  if (!key) throw new Error("PERSO_API_KEY is not set");
  return key;
}

export function persoSpaceSeq(): number {
  const seq = Number(process.env.PERSO_SPACE_SEQ);
  if (!Number.isFinite(seq) || seq <= 0) throw new Error("PERSO_SPACE_SEQ is not set or invalid");
  return seq;
}
