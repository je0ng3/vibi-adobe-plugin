console.warn("[uxp-stub] running in browser preview mode — UXP APIs are simulated");

const formats = { binary: Symbol("binary"), utf8: Symbol("utf8") };

interface StubEntry {
  name: string;
  read: (opts: { format: unknown }) => Promise<ArrayBuffer>;
}

const localFileSystem = {
  async getEntryWithUrl(url: string): Promise<never> {
    throw new Error(`[preview] cannot read file path in browser: ${url}`);
  },
  async getTemporaryFolder(): Promise<never> {
    throw new Error("[preview] temp folder not available in browser");
  },
  async getFileForOpening(opts?: { types?: string[]; allowMultiple?: boolean }): Promise<StubEntry | StubEntry[] | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      if (opts?.types?.length) {
        input.accept = opts.types.map((t) => `.${t}`).join(",");
      }
      if (opts?.allowMultiple) input.multiple = true;
      input.onchange = async () => {
        const files = Array.from(input.files ?? []);
        if (files.length === 0) {
          resolve(null);
          return;
        }
        const entries: StubEntry[] = await Promise.all(
          files.map(async (file) => {
            const buffer = await file.arrayBuffer();
            return {
              name: file.name,
              async read() {
                return buffer;
              },
            };
          }),
        );
        resolve(opts?.allowMultiple ? entries : entries[0]);
      };
      input.oncancel = () => resolve(null);
      input.click();
    });
  },
  async getFileForSaving(suggestedName: string): Promise<{ name: string; write: (data: ArrayBuffer) => Promise<void> }> {
    // Browser preview: emulate "save" with an anchor download triggered on write().
    return {
      name: suggestedName,
      async write(data: ArrayBuffer) {
        const url = URL.createObjectURL(new Blob([data]));
        const a = document.createElement("a");
        a.href = url;
        a.download = suggestedName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
    };
  },
};

const secureStorage = {
  async getItem(key: string): Promise<Uint8Array | null> {
    const raw = localStorage.getItem(`preview:${key}`);
    return raw == null ? null : new TextEncoder().encode(raw);
  },
  async setItem(key: string, value: Uint8Array | string): Promise<void> {
    const text = value instanceof Uint8Array ? new TextDecoder("utf-8").decode(value) : value;
    localStorage.setItem(`preview:${key}`, text);
  },
  async removeItem(key: string): Promise<void> {
    localStorage.removeItem(`preview:${key}`);
  },
};

export const storage = { localFileSystem, secureStorage, formats };

export const shell = {
  async openExternal(url: string): Promise<void> {
    window.open(url, "_blank", "noopener");
  },
};
