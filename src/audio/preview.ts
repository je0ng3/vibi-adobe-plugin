import { storage, shell } from "uxp";
import { audioUrlToBytes } from "./audioUrl";

// Last-resort preview: hand the clip to the OS default audio app (temp write + shell-open, both
// supported in UXP). Used only when neither in-panel backend is available — i.e. no AudioContext
// AND no Source Monitor (see player.ts / sourceMonitorPlayer.ts). In normal Premiere UXP the
// Source Monitor backend handles preview in-panel, so this path rarely runs.
export async function previewInDefaultApp(url: string, fileName: string): Promise<void> {
  const bytes = await audioUrlToBytes(url);
  const tmp = await storage.localFileSystem.getTemporaryFolder();
  const safe = fileName.replace(/[^\w.-]+/g, "_") || "preview.wav";
  const file = await tmp.createFile(safe, { overwrite: true });
  await file.write(bytes, { format: storage.formats.binary });

  const path = (file as unknown as { nativePath: string }).nativePath;
  const sh = shell as unknown as {
    openPath?: (p: string) => Promise<unknown>;
    openExternal?: (u: string) => Promise<unknown>;
  };
  if (typeof sh.openPath === "function") {
    await sh.openPath(path);
  } else if (typeof sh.openExternal === "function") {
    await sh.openExternal(path);
  } else {
    throw new Error("UXP shell has no openPath/openExternal");
  }
}
