// UXP's fetch does not reliably serialize a `FormData` body to multipart/form-data — the
// server receives no fields and rejects the upload (separation returned 400 audio_required).
// Build the multipart body by hand as an ArrayBuffer and set the boundary on Content-Type
// ourselves. A raw ArrayBuffer body IS sent correctly by UXP fetch. The server still parses
// it with the standard Request.formData(), so no server change is needed.

export interface MultipartFilePart {
  field: string;
  fileName: string;
  bytes: ArrayBuffer;
  contentType?: string;
}

const CRLF = "\r\n";

// Header text (boundaries, dispositions, field values) is ASCII. The filename is forced to
// ASCII too so the header stays well-formed — the server only reads its extension and uses it
// as a storage name, so a sanitized name is harmless.
function asciiBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
}

function asciiFilename(name: string): string {
  return name.replace(/[\\"\r\n]/g, "_").replace(/[^\x20-\x7E]/g, "_");
}

export function buildMultipart(
  fields: Record<string, string>,
  files: MultipartFilePart[],
): { body: ArrayBuffer; contentType: string } {
  const boundary =
    "----vibiFormBoundary" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const chunks: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      asciiBytes(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
      ),
    );
  }
  for (const f of files) {
    chunks.push(
      asciiBytes(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="${f.field}"; filename="${asciiFilename(f.fileName)}"${CRLF}` +
          `Content-Type: ${f.contentType ?? "application/octet-stream"}${CRLF}${CRLF}`,
      ),
    );
    chunks.push(new Uint8Array(f.bytes));
    chunks.push(asciiBytes(CRLF));
  }
  chunks.push(asciiBytes(`--${boundary}--${CRLF}`));

  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.byteLength;
  }
  return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
