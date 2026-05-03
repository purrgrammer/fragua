// URL-safe encoding of an absolute project root (`run_state.cwd`) into a
// single path segment, and back. Base64url so a path with `/`, spaces,
// or other characters reserved by the URL grammar survives a round trip
// without needing a `*` catch-all on the route.
//
// Encode/decode are deliberately strict — any input the encoder produces
// must round-trip; anything else returns `null` so callers can render a
// "not found" state instead of querying the API with garbage.

/** Encode an absolute path into a URL-safe single segment. */
export function encodeProjectId(cwd: string): string {
  const bytes = new TextEncoder().encode(cwd);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the segment back into the original path. Returns `null` on
 *  malformed input — pad and base64url → base64, then atob → bytes →
 *  utf-8 string. */
export function decodeProjectId(segment: string): string | null {
  try {
    const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=");
    const b64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
