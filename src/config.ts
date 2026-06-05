// Backend base URL. Overridable at build time via Vite define (VIBI_BFF_BASE_URL).
declare const __VIBI_BFF_BASE_URL__: string | undefined;

export const BFF_BASE_URL =
  typeof __VIBI_BFF_BASE_URL__ === "string" && __VIBI_BFF_BASE_URL__.length > 0
    ? __VIBI_BFF_BASE_URL__
    : "http://localhost:8787";

// Reject audio larger than this to avoid out-of-memory on decode/upload.
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200 MB
