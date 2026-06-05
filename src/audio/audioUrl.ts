// Audio "URL handles" for in-panel stems / mix.
//
// The panel passes around an audio URL string as a lightweight handle and reads the bytes
// back when it needs to play, mix, preview, or import. The obvious way — createObjectURL +
// fetch(objectURL) — is **Medium-risk / unverified in UXP** (KNOWN_ISSUES): both the Blob URL
// minting and fetching it back can be absent or flaky in the Premiere runtime. So every handle
// also stashes its raw bytes in an in-memory registry, and callers read bytes via
// audioUrlToBytes (registry-first, fetch only as a last resort). createObjectURL itself is
// guarded: if it throws / is missing we mint a synthetic "mem://" handle and rely solely on
// the registry. Either way the rest of the app is unaffected by whether Blob URLs work.

const registry = new Map<string, ArrayBuffer>();
let counter = 0;

/** Create an audio URL handle for `bytes`, also caching the bytes for fetch-free reads. */
export function makeAudioUrl(bytes: ArrayBuffer, mimeType = "audio/wav"): string {
  let url: string;
  try {
    url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  } catch {
    url = `mem://audio/${counter++}`;
  }
  registry.set(url, bytes);
  return url;
}

/** Drop a handle's cached bytes and revoke the object URL if it was a real one. */
export function revokeAudioUrl(url: string | null | undefined): void {
  if (!url) return;
  registry.delete(url);
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* synthetic mem:// handle, or revoke unavailable — nothing to do */
  }
}

/** Read a handle's bytes: from the registry (no I/O) when known, else fetch as a fallback. */
export async function audioUrlToBytes(url: string): Promise<ArrayBuffer> {
  const cached = registry.get(url);
  if (cached) return cached;
  // Not one of our handles (e.g. an externally supplied URL) — fall back to fetch.
  return (await fetch(url)).arrayBuffer();
}
