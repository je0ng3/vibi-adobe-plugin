export interface TarEntry {
  name: string;
  bytes: ArrayBuffer;
}

export function extractTar(buffer: ArrayBuffer): TarEntry[] {
  const view = new Uint8Array(buffer);
  const decoder = new TextDecoder("utf-8");
  const out: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= view.byteLength) {
    const header = view.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    const rawName = decoder.decode(header.subarray(0, 100)).split("\0")[0];
    const sizeOctal = decoder.decode(header.subarray(124, 124 + 12)).split("\0")[0].trim();
    const typeFlag = String.fromCharCode(header[156]);
    const parsedSize = parseInt(sizeOctal, 8);
    const size = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : 0;

    offset += 512;

    if (size > 0 && (typeFlag === "0" || typeFlag === "\0")) {
      const dataStart = offset;
      const dataEnd = dataStart + size;
      if (dataEnd > view.byteLength) break;
      const safeName = basename(rawName);
      out.push({
        name: safeName.length > 0 ? safeName : `entry_${out.length}`,
        bytes: buffer.slice(dataStart, dataEnd),
      });
    }

    offset += Math.ceil(size / 512) * 512;
  }

  return out;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}
