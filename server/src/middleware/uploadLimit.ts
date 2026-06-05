import { bodyLimit } from "hono/body-limit";

// Abort a request as soon as its body exceeds `maxSize`, BEFORE the whole thing is buffered
// into memory. The per-route `file.size > MAX` checks run only AFTER `c.req.formData()` has
// already read the entire (possibly multi-GB) body, so on their own they don't stop a memory
// exhaustion DoS — this middleware does. Keep both: this bounds the raw body, the size check
// bounds the decoded file. A reverse-proxy body cap (Caddy/nginx) should back this in prod.
export function uploadLimit(maxBytes: number) {
  return bodyLimit({
    maxSize: maxBytes,
    onError: (c) => c.json({ error: "file_too_large", maxBytes }, 413),
  });
}
