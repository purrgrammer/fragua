// CLI-side input plumbing shared by `run` and `ci` (a command module is a graph
// leaf, so neither imports from the other). This layer ONLY resolves strings:
//   - `resolveInputArgs` turns `--input name=value` args into a string map,
//     sourcing `@<path>` / `@-` (stdin) verbatim.
//   - `coerceInputs` merges an optional whole-object `--input-json` with the
//     per-`--input` string overrides.
// Type coercion (string → number / boolean / object / array, by declared type)
// is NOT done here — it lives in the SHARED write surface (`intent-plane`
// `buildEnqueue` → `coerceInputBindings`) that both the CLI and the HTTP server
// route through, so the two clients can't disagree about what a value coerces
// to. This module hands `buildEnqueue` raw strings (and already-parsed
// `--input-json` values); `buildEnqueue` coerces + validates.

import { readFile } from "node:fs/promises";

/** Parse repeated `--input name=value` args into a resolved string map. A value
 * of `@<path>` reads the file verbatim; `@-` reads stdin (once, cached for
 * reuse). Throws on a malformed entry (missing `=` or empty name) or an
 * unreadable `@` source. */
export async function resolveInputArgs(raw: string | string[] | undefined): Promise<Record<string, string>> {
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const out: Record<string, string> = {};
  let stdinCache: string | undefined;
  for (const entry of list) {
    const s = String(entry);
    const eq = s.indexOf("=");
    if (eq <= 0) throw new Error(`--input must be name=value (got ${JSON.stringify(s)})`);
    const name = s.slice(0, eq);
    const rawVal = s.slice(eq + 1);
    if (rawVal.startsWith("@")) {
      const src = rawVal.slice(1);
      if (src === "-") {
        stdinCache ??= await Bun.stdin.text();
        out[name] = stdinCache;
      } else {
        out[name] = await readFile(src, "utf8");
      }
    } else {
      out[name] = rawVal;
    }
  }
  return out;
}

/** Merge an optional whole-object `--input-json` with per-`--input` string
 * overrides. `--input-json` (parsed once) seeds the map; each `--input
 * name=value` string overlays it. Returns the merged record verbatim — scalar
 * coercion and JSON-parsing of object / array inputs happen downstream in
 * `buildEnqueue` (`coerceInputBindings`), the single shared coercion site.
 *
 * Only the `__proto__` key is filtered from `--input-json` (a `{"__proto__":…}`
 * payload would otherwise invoke the prototype setter via bracket assignment);
 * `constructor` / `prototype` are set as own properties, symmetric with the
 * `--input k=v` path. Malformed JSON (or a non-object) for `--input-json`
 * throws a clean error naming the offender. */
export function coerceInputs(
  rawStrings: Record<string, string>,
  inputJson: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (inputJson !== undefined) {
    let whole: unknown;
    try {
      whole = JSON.parse(inputJson);
    } catch (err) {
      throw new Error(`--input-json is not valid JSON: ${(err as Error).message}`);
    }
    if (whole === null || typeof whole !== "object" || Array.isArray(whole)) {
      throw new Error("--input-json must be a JSON object mapping input names to values");
    }
    for (const [k, v] of Object.entries(whole as Record<string, unknown>)) {
      if (k === "__proto__") continue;
      out[k] = v;
    }
  }
  for (const [name, value] of Object.entries(rawStrings)) {
    out[name] = value;
  }
  return out;
}
