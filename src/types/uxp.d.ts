declare module "uxp" {
  export namespace storage {
    interface File {
      nativePath: string;
      read(options?: { format?: symbol }): Promise<ArrayBuffer>;
      write(data: ArrayBuffer, options?: { format?: symbol }): Promise<void>;
      // Used to watch an Adobe Media Encoder output file grow to a stable size while we
      // wait for a MOV→audio extraction to finish (see host/encoder.ts).
      getMetadata(): Promise<{ size: number }>;
    }
    interface Folder {
      createFile(name: string, options?: { overwrite?: boolean }): Promise<File>;
      getEntry(name: string): Promise<File>;
    }
    interface LocalFileSystem {
      getEntryWithUrl(url: string): Promise<File>;
      getTemporaryFolder(): Promise<Folder>;
      // The plugin's own install folder — used to read the bundled AAC/MP3 export preset
      // (vibi-extract-mp3.epr) that drives Premiere's encoder.
      getPluginFolder(): Promise<Folder>;
      getFileForOpening(options?: {
        types?: string[];
        allowMultiple?: boolean;
      }): Promise<File | File[] | null>;
      getFileForSaving(suggestedName: string, options?: { types?: string[] }): Promise<File | null>;
    }
    interface SecureStorage {
      getItem(key: string): Promise<Uint8Array | string | null>;
      setItem(key: string, value: Uint8Array | string): Promise<void>;
      removeItem(key: string): Promise<void>;
    }
    const localFileSystem: LocalFileSystem;
    const secureStorage: SecureStorage;
    const formats: { binary: symbol; utf8: symbol };
  }

  export namespace shell {
    function openExternal(url: string): Promise<void>;
  }
}

declare module "premierepro" {
  export interface ProjectItem {
    getMediaFilePath(): Promise<string>;
  }
  export interface Clip {
    projectItem: ProjectItem;
  }
  export interface Sequence {
    getSelection(): Promise<Clip[] | null>;
    appendClipToAudioTrack(item: ProjectItem, trackIndex: number): Promise<void>;
    // Current playhead (CTI) position as a TickTime — where the mix lands when the source
    // wasn't a timeline selection.
    getPlayerPosition(): Promise<TickTimeInstance>;
  }
  export interface Project {
    getActiveSequence(): Promise<Sequence>;
    importFiles(paths: string[]): Promise<ProjectItem[]>;
    getRootItem(): Promise<unknown>;
    // Transactional editing — required to apply SequenceEditor actions (clip placement).
    lockedAccess(fn: () => void): void;
    executeTransaction(
      fn: (compoundAction: { addAction(action: unknown): void }) => void,
      label?: string,
    ): boolean;
  }
  export const Project: {
    getActiveProject(): Promise<Project>;
  };
  export interface ClipProjectItemInstance {
    getMediaFilePath(): Promise<string>;
  }
  export const ClipProjectItem: {
    cast(item: unknown): ClipProjectItemInstance | null;
  };
  // A timeline clip (track item). getStartTime is its sequence-relative position — used to drop
  // the mix back where the originally-selected clip sits.
  export interface TrackItem {
    getStartTime(): Promise<TickTimeInstance>;
  }
  // Places clips onto sequence tracks. createOverwriteItemAction(projectItem, time,
  // videoTrackIndex, audioTrackIndex) returns an action applied inside a project transaction.
  export const SequenceEditor: {
    getEditor(sequence: Sequence): {
      createOverwriteItemAction(
        projectItem: ProjectItem,
        time: TickTimeInstance,
        videoTrackIndex: number,
        audioTrackIndex: number,
      ): unknown;
    };
  } | null;
  export interface TickTimeInstance {
    readonly seconds: number;
  }
  // Host's Source Monitor — used as the in-panel preview engine when Web Audio is absent.
  export const SourceMonitor: {
    openFilePath(nativePath: string): Promise<unknown>;
    play(speed: number): Promise<unknown>;
    getPosition(): Promise<TickTimeInstance>;
    setPosition(position: unknown): Promise<boolean>;
    closeClip(): Promise<unknown>;
    closeAllClips(): Promise<unknown>;
  } | null;
  export const TickTime: {
    createWithSeconds(seconds: number): TickTimeInstance;
    readonly TIME_ZERO: TickTimeInstance;
    // Passed as the out-point to EncoderManager.encodeFile so it encodes through to the
    // end of the source (see Adobe's encoderManager sample).
    readonly TIME_INVALID: TickTimeInstance;
  } | null;

  // Drives Adobe Media Encoder to extract/transcode media. We use it to pull the audio
  // track out of a video clip (e.g. MOV) into a small MP3 before separation. Requires AME
  // to be installed (isAMEInstalled). Null in the browser-preview stub.
  export interface EncoderManagerInstance {
    readonly isAMEInstalled: boolean;
    // Returns a job-id string when queued; 0 / false on failure to queue. The trailing args are
    // optional in some host versions: workArea (0=entire,1=in/out,2=work area),
    // removeUponCompletion, and startQueueImmediately (true → AME renders without the user
    // clicking Start Queue). Passing extra args is harmless on versions that ignore them.
    encodeFile(
      mediaPath: string,
      outputPath: string,
      presetPath: string,
      inPoint: TickTimeInstance,
      outPoint: TickTimeInstance,
      workArea?: number,
      removeUponCompletion?: boolean,
      startQueueImmediately?: boolean,
    ): Promise<string | number | boolean> | string | number | boolean;
    startBatchEncode(): Promise<boolean> | boolean;
  }
  export const EncoderManager: {
    getManager(): EncoderManagerInstance;
  } | null;
}
