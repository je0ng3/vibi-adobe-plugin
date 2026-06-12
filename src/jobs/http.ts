// Parse a successful response body as JSON. A 2xx with a non-JSON body — a proxy splash page, a
// gateway interstitial, a truncated/gzip-mismatched payload — makes `res.json()` reject with a
// raw "SyntaxError: Unexpected token <". This turns that into a clear, user-facing message.
// Call only after the `res.ok` check.
export async function readJson<T>(res: Response, context: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${context}: unexpected response from server`);
  }
}
