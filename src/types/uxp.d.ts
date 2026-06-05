declare module "uxp" {
  export namespace storage {
    interface File {
      nativePath: string;
      read(options?: { format?: symbol }): Promise<ArrayBuffer>;
      write(data: ArrayBuffer, options?: { format?: symbol }): Promise<void>;
    }
    interface Folder {
      createFile(name: string, options?: { overwrite?: boolean }): Promise<File>;
    }
    interface LocalFileSystem {
      getEntryWithUrl(url: string): Promise<File>;
      getTemporaryFolder(): Promise<Folder>;
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
  }
  export interface Project {
    getActiveSequence(): Promise<Sequence>;
    importFiles(paths: string[]): Promise<ProjectItem[]>;
    getRootItem(): Promise<unknown>;
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
}
