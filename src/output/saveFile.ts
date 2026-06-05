import { storage } from "uxp";

/**
 * Save bytes to a user-chosen location via the UXP file picker. `<a download>.click()`
 * does NOT work in the UXP runtime (KNOWN_ISSUES.md), so all downloads must go through
 * `getFileForSaving` + `file.write`. In the browser preview the stub falls back to an
 * anchor download. Returns false if the user canceled the save dialog.
 */
export async function saveBytes(suggestedName: string, bytes: ArrayBuffer): Promise<boolean> {
  const file = await storage.localFileSystem.getFileForSaving(suggestedName);
  if (!file) return false;
  await file.write(bytes, { format: storage.formats.binary });
  return true;
}

/** Fetch a Blob URL's bytes, then save them. Used for blob-URL-backed audio/SRT outputs. */
export async function saveFromUrl(suggestedName: string, url: string): Promise<boolean> {
  const bytes = await (await fetch(url)).arrayBuffer();
  return saveBytes(suggestedName, bytes);
}
