import { storage } from "uxp";
import { Project, ClipProjectItem } from "premierepro";
import type { LoadedAudioSource } from "../input/audioPicker";
import { extractAudioFromBytes } from "../jobs/extractClient";

const AUDIO_EXTS = new Set(["m4a", "mp3", "wav"]);

// UXP cannot receive a native drag from Premiere (the host UI's drag payload never reaches
// the web layer — only OS-filesystem file drops do). The supported equivalent: the user
// selects audio in Premiere, then we read the underlying media of the selection. We gather
// the selection from BOTH the Project panel (if that API exists in this version) and the
// active sequence (timeline), dedupe by media path, and read each audio file's bytes.
// Non-audio selections (e.g. video) are skipped with a clear export-audio hint.
export async function readSelectedAudioClips(): Promise<LoadedAudioSource[]> {
  console.log("[premiere] readSelectedAudioClips: getting active project…");
  const project = await Project.getActiveProject();
  console.log("[premiere] active project:", !!project);
  if (!project) throw new Error("Open a project first");

  const projectItems = await collectSelectedProjectItems(project);
  if (projectItems.length === 0) {
    throw new Error(
      "No audio selected. Select an audio clip in the timeline (or an item in the Project panel), then click again.",
    );
  }

  const sources: LoadedAudioSource[] = [];
  const seenPaths = new Set<string>();
  const skipped: string[] = [];

  for (const projectItem of projectItems) {
    console.log(
      "[premiere] projectItem methods:",
      listMatching(projectItem, /media|path|name|content|footage/i).join(", "),
    );
    const mediaPath = await resolveMediaPath(projectItem);
    console.log("[premiere] mediaPath:", JSON.stringify(mediaPath));
    if (!mediaPath || seenPaths.has(mediaPath)) continue;
    seenPaths.add(mediaPath);

    const fileName = mediaPath.split(/[\\/]/).pop() ?? "clip";
    try {
      sources.push(await readMediaToSource(mediaPath));
    } catch (e) {
      console.log("[premiere] read/extract failed:", e);
      skipped.push(fileName);
    }
  }

  if (sources.length === 0) {
    const detail = skipped.length > 0 ? ` (${skipped.join(", ")})` : "";
    throw new Error(`Couldn't read audio from the selection${detail}.`);
  }
  return sources;
}

function toArray(x: any): any[] {
  return Array.isArray(x) ? x : x ? [x] : [];
}

// Read a media file path into a LoadedAudioSource: audio is read directly; video (or any
// non-audio media) has its audio extracted to mp3 server-side.
async function readMediaToSource(mediaPath: string): Promise<LoadedAudioSource> {
  const fileName = mediaPath.split(/[\\/]/).pop() ?? "clip";
  const ext = mediaPath.toLowerCase().split(".").pop() ?? "";
  const file = await storage.localFileSystem.getEntryWithUrl(`file:${mediaPath}`);
  const raw = await file.read({ format: storage.formats.binary });
  if (AUDIO_EXTS.has(ext)) {
    return { bytes: raw, fileName, ext, byteLength: raw.byteLength };
  }
  // Video (or other non-audio media): read the bytes locally and upload them so the server
  // extracts the audio track to mp3. We upload bytes, not the path — the server never opens a
  // client-supplied path (see extractClient).
  const bytes = await extractAudioFromBytes(raw, fileName);
  const base = fileName.replace(/\.[^.]+$/, "");
  return { bytes, fileName: `${base}.mp3`, ext: "mp3", byteLength: bytes.byteLength };
}

export interface ProjectMediaItem {
  name: string;
  mediaPath: string;
  ext: string;
}

// Walk the project's bin tree (no selection API exists for the Project panel) and list every
// media-backed item with a file path. Used by the in-panel project browser so the user can
// pick a Project-panel item to import.
export async function listProjectMediaItems(): Promise<ProjectMediaItem[]> {
  const project = await Project.getActiveProject();
  if (!project) throw new Error("Open a project first");
  const root = await project.getRootItem();

  const out: ProjectMediaItem[] = [];
  const seen = new Set<string>();

  async function walk(item: any, depth: number): Promise<void> {
    if (!item || depth > 10) return;

    // Media-backed item? Cast to ClipProjectItem and read its path.
    let mediaPath: string | undefined;
    try {
      const clip = ClipProjectItem?.cast?.(item) as unknown as {
        getMediaFilePath?: () => Promise<string>;
      } | null;
      if (clip && typeof clip.getMediaFilePath === "function") {
        const p = await clip.getMediaFilePath();
        if (p) mediaPath = String(p);
      }
    } catch {
      /* not a clip item */
    }
    if (mediaPath) {
      if (!seen.has(mediaPath)) {
        seen.add(mediaPath);
        const name = (item.name as string) || mediaPath.split(/[\\/]/).pop() || mediaPath;
        out.push({ name, mediaPath, ext: mediaPath.toLowerCase().split(".").pop() ?? "" });
      }
      return;
    }

    // Otherwise treat as a bin/folder and recurse into its children.
    for (const accessor of ["getItems", "getChildren", "getSubClips"]) {
      if (typeof item[accessor] === "function") {
        try {
          for (const kid of toArray(await item[accessor]())) await walk(kid, depth + 1);
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }

  await walk(root, 0);
  console.log("[premiere] project media items:", out.length);
  return out;
}

// Import a single project media item (by path) — audio read or video audio-extracted.
export async function importProjectMediaItem(mediaPath: string): Promise<LoadedAudioSource> {
  return readMediaToSource(mediaPath);
}

// Method names on the object's chain matching a pattern (short, readable diagnostic).
function listMatching(obj: any, re: RegExp): string[] {
  const out = new Set<string>();
  let o = obj;
  for (let d = 0; o && d < 6; d++) {
    for (const n of Object.getOwnPropertyNames(o)) if (re.test(n)) out.add(n);
    o = Object.getPrototypeOf(o);
  }
  return [...out];
}

// Resolve a ProjectItem's media file path across API variants. getMediaFilePath may live on
// the projectItem, or require getContentPath / a ProjectItem.getMediaPath-style accessor.
async function resolveMediaPath(projectItem: any): Promise<string | undefined> {
  // Direct accessors, if this item happens to expose one.
  for (const name of ["getMediaFilePath", "getMediaPath", "getContentPath", "getFilePath"]) {
    if (typeof projectItem?.[name] === "function") {
      try {
        const p = await projectItem[name]();
        if (p) return String(p);
      } catch (e) {
        console.log(`[premiere] ${name}() threw:`, e);
      }
    }
  }
  // A plain ProjectItem (only name/createSetNameAction) must be cast to a ClipProjectItem to
  // reach getMediaFilePath — this is the documented Premiere UXP path.
  try {
    const clipItem = ClipProjectItem?.cast?.(projectItem) as unknown as {
      getMediaFilePath?: () => Promise<string>;
    } | null;
    if (clipItem && typeof clipItem.getMediaFilePath === "function") {
      const p = await clipItem.getMediaFilePath();
      if (p) return String(p);
    } else {
      console.log("[premiere] ClipProjectItem.cast ->", clipItem ? "ok (no getMediaFilePath)" : "null");
    }
  } catch (e) {
    console.log("[premiere] ClipProjectItem.cast/getMediaFilePath threw:", e);
  }
  return undefined;
}

// A timeline TrackItem doesn't expose `.projectItem` directly in this API. Resolve the
// underlying media-backed ProjectItem (or an object that itself has getMediaFilePath) by
// trying the known/likely accessors.
async function resolveProjectItem(clip: any): Promise<any> {
  if (!clip) return null;
  if (clip.projectItem) return clip.projectItem;
  for (const name of ["getProjectItem", "getClipProjectItem", "getMediaProjectItem"]) {
    if (typeof clip[name] === "function") {
      try {
        const pi = await clip[name]();
        if (pi) return pi;
      } catch {
        /* try next */
      }
    }
  }
  // The clip itself may expose getMediaFilePath — usable directly downstream.
  if (typeof clip.getMediaFilePath === "function") return clip;
  return null;
}

// Find zero-arg getter methods whose name contains "select" anywhere on the object's
// prototype chain — the Project-panel selection getter, whose exact name varies by version
// (and may be absent). Only zero-arg getters are returned, so calling them is side-effect
// free (we never invoke setSelection/clearSelection).
function findSelectionGetters(obj: any): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let o = obj;
  for (let depth = 0; o && depth < 6; depth++) {
    for (const n of Object.getOwnPropertyNames(o)) {
      if (seen.has(n)) continue;
      seen.add(n);
      if (!/select/i.test(n) || !/^get/i.test(n)) continue;
      try {
        const fn = obj[n];
        if (typeof fn === "function" && fn.length === 0) out.push(n);
      } catch {
        /* getter threw — skip */
      }
    }
    o = Object.getPrototypeOf(o);
  }
  return out;
}

// Collect ProjectItems from the current Premiere selection: the Project panel (auto-detected
// selection getter) and the active sequence (known sequence.getSelection). Returns
// media-backed ProjectItems.
async function collectSelectedProjectItems(project: any): Promise<any[]> {
  const items: any[] = [];

  // 1) Project panel selection — auto-discovered getter.
  const getters = findSelectionGetters(project);
  console.log("[premiere] project selection getters:", getters.length ? getters.join(", ") : "(none)");
  if (!getters.length) {
    console.log(
      "[premiere] project candidate methods:",
      listMatching(project, /select|view|panel|active|current|bin|item|root/i).join(", ") || "(none)",
    );
  }
  for (const name of getters) {
    try {
      const sel = await project[name]();
      const arr = toArray(sel);
      console.log(`[premiere] ${name}() -> ${arr.length} item(s)`);
      for (const it of arr) {
        const pi = it?.projectItem ?? it;
        if (pi) items.push(pi);
      }
      if (items.length) break;
    } catch (e) {
      console.log(`[premiere] ${name}() threw:`, e);
    }
  }

  // 2) Timeline (active sequence) selection.
  try {
    const sequence = await project.getActiveSequence();
    if (sequence && typeof sequence.getSelection === "function") {
      const sel = await sequence.getSelection();
      // getSelection() returns a TrackItemSelection *container*, not the items — expand it.
      let clips = toArray(sel);
      const container = clips[0];
      if (clips.length === 1 && container && typeof container.getTrackItems === "function") {
        clips = toArray(await container.getTrackItems());
      } else if (clips.length === 1 && container && typeof container.getItems === "function") {
        clips = toArray(await container.getItems());
      }
      console.log(`[premiere] timeline selection -> ${clips.length} track item(s)`);
      if (clips[0]) {
        console.log("[premiere] trackitem methods:", listMatching(clips[0], /project|media|item|name|clip/i).join(", "));
      }
      for (const clip of clips) {
        const pi = await resolveProjectItem(clip);
        if (pi) items.push(pi);
      }
    } else {
      console.log("[premiere] no active sequence / getSelection");
    }
  } catch (e) {
    console.log("[premiere] timeline getSelection threw:", e);
  }

  console.log("[premiere] total selected project items:", items.length);
  return items;
}

// A separation result (stem or mix) to push back into Premiere.
export interface AudioToImport {
  fileName: string;
  bytes: ArrayBuffer;
}

// UXP cannot drag out to Premiere's native Project panel / timeline either (no UXP→host
// drag bridge). The supported equivalent is programmatic import: write the result to a
// temp file, then importFiles() into the project — optionally placing it on the timeline.
async function writeAudioToTemp(fileName: string, bytes: ArrayBuffer): Promise<string> {
  const temp = await storage.localFileSystem.getTemporaryFolder();
  // Strip path separators / illegal chars; keep the extension so Premiere detects the codec.
  const safe = fileName.replace(/[\\/:*?"<>|]/g, "_");
  const file = await temp.createFile(safe, { overwrite: true });
  await file.write(bytes, { format: storage.formats.binary });
  return file.nativePath;
}

// Import into the Project panel only.
export async function importAudioToProject(items: AudioToImport[]): Promise<void> {
  if (items.length === 0) return;
  const project = await Project.getActiveProject();
  if (!project) throw new Error("Open a project first");
  const paths = await Promise.all(items.map((i) => writeAudioToTemp(i.fileName, i.bytes)));
  await project.importFiles(paths);
}

// The Premiere UXP track API surface varies by version; probe what's available rather than
// assume. Methods are optional and feature-detected at call time.
type AnySequence = {
  appendClipToAudioTrack: (item: unknown, trackIndex: number) => Promise<void>;
  getAudioTrackCount?: () => Promise<number> | number;
  addAudioTrack?: () => Promise<void> | void;
  addTracks?: (videoCount: number, audioCount: number) => Promise<void> | void;
};

async function audioTrackCount(seq: AnySequence): Promise<number | null> {
  if (typeof seq.getAudioTrackCount !== "function") return null;
  try {
    return await seq.getAudioTrackCount();
  } catch {
    return null;
  }
}

// Grow the sequence to at least `needed` audio tracks using whichever add-track API exists.
// Returns the resulting track count, or null if the runtime can't be introspected/grown
// (callers then fall back to existing tracks).
async function ensureAudioTracks(seq: AnySequence, needed: number): Promise<number | null> {
  let count = await audioTrackCount(seq);
  if (count == null) return null;
  while (count < needed) {
    let added = false;
    if (typeof seq.addAudioTrack === "function") {
      try {
        await seq.addAudioTrack();
        added = true;
      } catch {
        /* try next strategy */
      }
    }
    if (!added && typeof seq.addTracks === "function") {
      try {
        await seq.addTracks(0, 1);
        added = true;
      } catch {
        /* give up below */
      }
    }
    if (!added) break;
    const next = await audioTrackCount(seq);
    if (next == null || next <= count) break; // no API progress — stop, don't loop forever
    count = next;
  }
  return count;
}

// Import into the Project panel and place each on its own audio track of the active
// sequence (separate tracks so time-aligned stems overlap rather than concatenate). Adds
// tracks automatically when the sequence doesn't have enough; if track creation isn't
// supported, stems fall back onto the last existing track.
export async function importAudioToTimeline(items: AudioToImport[]): Promise<void> {
  if (items.length === 0) return;
  const project = await Project.getActiveProject();
  if (!project) throw new Error("Open a project first");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("Open a sequence in the timeline first");
  const paths = await Promise.all(items.map((i) => writeAudioToTemp(i.fileName, i.bytes)));
  const projectItems = await project.importFiles(paths);

  const seq = sequence as unknown as AnySequence;
  const trackCount = await ensureAudioTracks(seq, projectItems.length);

  for (let i = 0; i < projectItems.length; i++) {
    // One stem per track when possible; otherwise clamp to the last available track.
    const trackIndex = trackCount != null ? Math.min(i, Math.max(0, trackCount - 1)) : i;
    try {
      await seq.appendClipToAudioTrack(projectItems[i], trackIndex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Imported to the Project panel, but placing "${items[i].fileName}" on the timeline ` +
          `failed (${msg}). Add more audio tracks to the sequence and try again.`,
      );
    }
  }
}
