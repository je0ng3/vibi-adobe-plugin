// Backend base URL. Overridable at build time via Vite define (VIBI_BFF_BASE_URL).
declare const __VIBI_BFF_BASE_URL__: string | undefined;

export const BFF_BASE_URL =
  typeof __VIBI_BFF_BASE_URL__ === "string" && __VIBI_BFF_BASE_URL__.length > 0
    ? __VIBI_BFF_BASE_URL__
    : "http://localhost:8787";

// Payment/top-up gate. Off for the credits-only launch (users spend their signup bonus and
// nothing more). Flip on by building with VIBI_BILLING_ENABLED=true once Paddle goes live.
declare const __VIBI_BILLING_ENABLED__: boolean | undefined;
export const BILLING_ENABLED = __VIBI_BILLING_ENABLED__ === true;

// Reject audio larger than this to avoid out-of-memory on decode/upload.
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024; // 200 MB

// Legal pages, surfaced as links before sign-in (marketplace requirement).
export const PRIVACY_URL = "https://www.vibi.fm/privacy";
export const TERMS_URL = "https://www.vibi.fm/terms";
