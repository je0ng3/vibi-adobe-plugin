import { storage, shell } from "uxp";

// UXP can't play audio inside the panel (no Web Audio API, and the <audio> element's play()/pause()
// don't work — see player.ts / KNOWN_ISSUES). The realistic preview is to write the clip to a temp
// file and hand it to the OS default audio app. File write + shell-open are supported in UXP.
export async function previewInDefaultApp(url: string, fileName: string): Promise<void> {
  const bytes = await (await fetch(url)).arrayBuffer();
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
