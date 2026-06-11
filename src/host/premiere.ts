import { storage } from "uxp";
import { Project, ClipProjectItem, SequenceEditor, TickTime } from "premierepro";
import type { LoadedAudioSource } from "../input/audioPicker";
import { isVideoPath, convertVideoToAudio } from "./encoder";

// The separation backend only reliably handles these (keep in sync with audioPicker's
// SUPPORTED_EXTS and the server's util/audioFormat). vibi separates audio; video clips have
// their audio track extracted locally to MP3 first (see ./encoder), and anything that's
// neither audio nor a known video container is skipped.
const AUDIO_EXTS = new Set(["m4a", "mp3", "wav"]);

// Bytes from an audio path are uploaded as-is; a video path is first run through Premiere's
// encoder to pull out a small MP3 (convertVideoToAudio).
type StatusFn = (message: string) => void;

// UXP cannot receive a native drag from Premiere (the host UI's drag payload never reaches
// the web layer — only OS-filesystem file drops do). The supported equivalent: the user
// selects audio in Premiere, then we read the underlying media of the selection. We gather
// the selection from BOTH the Project panel (if that API exists in this version) and the
// active sequence (timeline), dedupe by media path, and read each audio file's bytes.
// Non-audio selections (e.g. video) are skipped with a clear export-audio hint.
export async function readSelectedAudioClips(onStatus?: StatusFn): Promise<LoadedAudioSource[]> {
  console.log("[premiere] readSelectedAudioClips: getting active project…");
  const project = await Project.getActiveProject();
  console.log("[premiere] active project:", !!project);
  if (!project) throw new Error("Open a project first");

  const selected = await collectSelectedProjectItems(project);
  if (selected.length === 0) {
    throw new Error(
      "No clip selected. Select an audio or video clip in the timeline (or an item in the Project panel), then click again.",
    );
  }

  const sources: LoadedAudioSource[] = [];
  const seenPaths = new Set<string>();
  const skipped: string[] = [];
  const unsupported: string[] = [];

  for (const { projectItem, startTimeSec } of selected) {
    console.log(
      "[premiere] projectItem methods:",
      listMatching(projectItem, /media|path|name|content|footage/i).join(", "),
    );
    const mediaPath = await resolveMediaPath(projectItem);
    console.log("[premiere] mediaPath:", JSON.stringify(mediaPath));
    if (!mediaPath || seenPaths.has(mediaPath)) continue;
    seenPaths.add(mediaPath);

    const fileName = mediaPath.split(/[\\/]/).pop() ?? "clip";
    // Audio uploads as-is; video has its audio extracted locally to MP3; anything else is skipped.
    if (!isAudioPath(mediaPath) && !isVideoPath(mediaPath)) {
      console.log("[premiere] skipping unsupported selection:", fileName);
      unsupported.push(fileName);
      continue;
    }
    try {
      const src = await loadClipSource(mediaPath, onStatus);
      // Remember where this clip sits on the timeline so a generated mix can drop back there.
      if (startTimeSec != null) src.timelineStartSec = startTimeSec;
      sources.push(src);
    } catch (e) {
      console.log("[premiere] load failed:", e);
      // Surface a real conversion error (e.g. AME missing) instead of a generic "couldn't read".
      if (isVideoPath(mediaPath) && e instanceof Error) throw e;
      skipped.push(fileName);
    }
  }

  if (sources.length === 0) {
    if (unsupported.length > 0) {
      throw new Error(
        `"${unsupported.join(", ")}" isn't a supported clip. Select an audio clip (mp3/wav/m4a) ` +
          `or a video clip (mov/mp4/…) and click again.`,
      );
    }
    const detail = skipped.length > 0 ? ` (${skipped.join(", ")})` : "";
    throw new Error(`Couldn't read audio from the selection${detail}.`);
  }
  return sources;
}

// Turn a clip's media path into an uploadable audio source: read audio directly, or extract a
// video's audio track to MP3 via Premiere's encoder first.
async function loadClipSource(mediaPath: string, onStatus?: StatusFn): Promise<LoadedAudioSource> {
  if (isVideoPath(mediaPath)) return convertVideoToAudio(mediaPath, { onStatus });
  return readMediaToSource(mediaPath);
}

// A stable key for the active Premiere project, used to scope the on-disk separation history
// to "this project". Prefer the project's GUID (immutable), then its file path (changes only if
// the .prproj is moved), then its name. Returns "default" when nothing is open or readable — so
// history still works (one shared bucket) for File-picker-only use without a project. Accessors
// vary by Premiere version and may be properties or methods, so probe defensively.
export async function getActiveProjectKey(): Promise<string> {
  try {
    const project: any = await Project.getActiveProject();
    if (!project) return "default";
    for (const name of ["guid", "id", "path", "name"]) {
      try {
        const v = typeof project[name] === "function" ? await project[name]() : project[name];
        if (v) return `${name}:${String(v)}`;
      } catch {
        /* try next accessor */
      }
    }
  } catch (e) {
    console.log("[premiere] getActiveProjectKey failed:", e);
  }
  return "default";
}

function toArray(x: any): any[] {
  return Array.isArray(x) ? x : x ? [x] : [];
}

// Read an audio file path into a LoadedAudioSource. Caller must have already confirmed the
// path is a supported audio file (isAudioPath) — vibi separates audio only, so video/unsupported
// media is filtered out upstream rather than extracted here.
async function readMediaToSource(mediaPath: string): Promise<LoadedAudioSource> {
  const fileName = mediaPath.split(/[\\/]/).pop() ?? "clip";
  const ext = mediaPath.toLowerCase().split(".").pop() ?? "";
  const file = await storage.localFileSystem.getEntryWithUrl(`file:${mediaPath}`);
  const raw = await file.read({ format: storage.formats.binary });
  return { bytes: raw, fileName, ext, byteLength: raw.byteLength };
}

function isAudioPath(mediaPath: string): boolean {
  return AUDIO_EXTS.has(mediaPath.toLowerCase().split(".").pop() ?? "");
}

export interface ProjectMediaItem {
  name: string;
  mediaPath: string;
  ext: string;
}

// Walk the project's bin tree (no selection API exists for the Project panel) and list every
// media-backed item whose source is a supported audio file OR a video container we can extract
// audio from. Used by the in-panel project browser so the user can pick a Project-panel item to
// import; video rows get their audio extracted to MP3 on pick (see importProjectMediaItem).
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
      // Show audio (uploaded as-is) and video (audio extracted on pick); skip the rest.
      if (!seen.has(mediaPath) && (isAudioPath(mediaPath) || isVideoPath(mediaPath))) {
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

// Import a single project media item (by path) — audio read directly, or video audio-extracted.
export async function importProjectMediaItem(
  mediaPath: string,
  onStatus?: StatusFn,
): Promise<LoadedAudioSource> {
  return loadClipSource(mediaPath, onStatus);
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

// A selected media-backed ProjectItem, plus (for timeline selections) the sequence-relative
// start time of the clip it came from so a mix can be dropped back at that position.
interface SelectedItem {
  projectItem: any;
  startTimeSec?: number;
}

// Read a timeline track item's sequence-relative start time in seconds, or undefined if the
// accessor is missing/throws (older API, or a Project-panel item with no timeline position).
async function trackItemStartSec(clip: any): Promise<number | undefined> {
  if (typeof clip?.getStartTime !== "function") return undefined;
  try {
    const t = await clip.getStartTime();
    const sec = typeof t?.seconds === "number" ? t.seconds : undefined;
    return Number.isFinite(sec) ? sec : undefined;
  } catch {
    return undefined;
  }
}

// Collect ProjectItems from the current Premiere selection: the Project panel (auto-detected
// selection getter) and the active sequence (known sequence.getSelection). Timeline selections
// also carry the clip's start time; Project-panel ones don't.
async function collectSelectedProjectItems(project: any): Promise<SelectedItem[]> {
  const items: SelectedItem[] = [];

  // 1) Project panel selection — auto-discovered getter. No timeline position here.
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
        if (pi) items.push({ projectItem: pi });
      }
      if (items.length) break;
    } catch (e) {
      console.log(`[premiere] ${name}() threw:`, e);
    }
  }

  // 2) Timeline (active sequence) selection — capture each clip's start time.
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
        console.log("[premiere] trackitem methods:", listMatching(clips[0], /project|media|item|name|clip|start|time/i).join(", "));
      }
      for (const clip of clips) {
        const pi = await resolveProjectItem(clip);
        if (pi) items.push({ projectItem: pi, startTimeSec: await trackItemStartSec(clip) });
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

// Where on the timeline a clip should land: an explicit sequence-relative time in seconds
// (the originally-selected clip's position) or, when omitted, the current playhead.
async function placementTime(sequence: any, atSeconds?: number): Promise<unknown> {
  if (atSeconds != null && TickTime) return TickTime.createWithSeconds(Math.max(0, atSeconds));
  // No explicit position → drop at the playhead (current-time indicator).
  try {
    const pos = await sequence.getPlayerPosition?.();
    if (pos) return pos;
  } catch (e) {
    console.log("[premiere] getPlayerPosition threw:", e);
  }
  if (TickTime) return TickTime.TIME_ZERO ?? TickTime.createWithSeconds(0);
  throw new Error("Couldn't determine a timeline position (no playhead and no TickTime API).");
}

// Place an imported audio ProjectItem onto a sequence audio track at `time` via the modern
// SequenceEditor transaction. `createOverwriteItemAction` overwrites on the target track — callers
// pass a freshly added (empty) track index so existing audio is never clobbered. Throws (loudly,
// with the cause) rather than failing silently, so a placement that the host rejects surfaces in
// the panel instead of leaving the clip in the Project panel only.
function placeClipViaEditor(
  project: any,
  sequence: any,
  projectItem: unknown,
  time: unknown,
  audioTrackIndex: number,
): void {
  console.log(
    `[premiere] placeClipViaEditor: SequenceEditor=${typeof SequenceEditor}, trackIndex=${audioTrackIndex}`,
  );
  if (!SequenceEditor || typeof SequenceEditor.getEditor !== "function") {
    throw new Error("SequenceEditor API unavailable in this Premiere build");
  }
  const editor: any = SequenceEditor.getEditor(sequence);
  console.log("[premiere] editor:", !!editor, "createOverwriteItemAction:", typeof editor?.createOverwriteItemAction);
  if (typeof project.lockedAccess !== "function" || typeof project.executeTransaction !== "function") {
    throw new Error(
      `transaction API missing (lockedAccess=${typeof project.lockedAccess}, executeTransaction=${typeof project.executeTransaction})`,
    );
  }

  let actionThrew: unknown = null;
  let ok: unknown = false;
  project.lockedAccess(() => {
    ok = project.executeTransaction((compound: { addAction(a: unknown): void }) => {
      try {
        // (projectItem, time, videoTrackIndex, audioTrackIndex). Audio-only media ignores the
        // video index; we pass 0.
        const action = editor.createOverwriteItemAction(projectItem, time, 0, audioTrackIndex);
        console.log("[premiere] overwrite action:", typeof action, action ? "created" : "null");
        compound.addAction(action);
      } catch (e) {
        actionThrew = e; // surface below — executeTransaction may swallow throws into a false return
        console.log("[premiere] createOverwriteItemAction threw:", e);
      }
    }, "Add audio to timeline");
  });
  console.log("[premiere] executeTransaction ok =", ok);
  if (actionThrew) {
    throw new Error(`createOverwriteItemAction failed: ${actionThrew instanceof Error ? actionThrew.message : String(actionThrew)}`);
  }
  if (ok === false) throw new Error("executeTransaction returned false (host rejected the placement)");
}

// Import into the Project panel AND drop each clip onto the active sequence at a chosen position:
// `atSeconds` (the originally-selected timeline clip's start) when provided, else the playhead.
// Each clip goes on its own freshly-added audio track so it overlaps the original in time without
// overwriting any existing audio.
export async function importAudioToTimeline(items: AudioToImport[], atSeconds?: number): Promise<void> {
  if (items.length === 0) return;
  const project = await Project.getActiveProject();
  if (!project) throw new Error("Open a project first");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("Open a sequence in the timeline first");
  const paths = await Promise.all(items.map((i) => writeAudioToTemp(i.fileName, i.bytes)));
  const projectItems = await project.importFiles(paths);
  console.log(`[premiere] importAudioToTimeline: imported ${projectItems?.length} item(s), atSeconds=${atSeconds}`);

  const seq = sequence as unknown as AnySequence;
  const time = await placementTime(sequence, atSeconds);
  console.log("[premiere] placement time seconds:", (time as any)?.seconds);

  // Reserve fresh tracks above the existing ones so placement is non-destructive.
  const before = await audioTrackCount(seq);
  const baseIndex = before ?? 0;
  const after = await ensureAudioTracks(seq, baseIndex + projectItems.length);
  console.log(`[premiere] audio tracks before=${before} after=${after} baseIndex=${baseIndex}`);

  for (let i = 0; i < projectItems.length; i++) {
    const audioTrackIndex = baseIndex + i;
    try {
      placeClipViaEditor(project, sequence, projectItems[i], time, audioTrackIndex);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `Imported to the Project panel, but placing "${items[i].fileName}" on the timeline ` +
          `failed: ${msg}`,
      );
    }
  }
}
