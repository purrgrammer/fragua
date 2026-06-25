// A source-hash gate: snapshot a hash over a chosen set of top-level
// declarations in a source file and fail the build when it moves unless a
// version constant and the snapshot move in the same diff. Shared by the
// event-contract gate (@fragua/store) and the IR-converter gate (@fragua/core),
// which are otherwise byte-for-byte identical save for the decls, paths, env
// var, and message prefix.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

/** A top-level declaration boundary: `export`-optional, `async`-optional, then
 * one of the declaration keywords. `class`/`enum`/`async function` are
 * recognized so inserting one between the gated decls can't silently shrink a
 * slice and drift the hash past coverage. */
const DECL_RE = /^(?:export\s+)?(?:async\s+)?(?:type|const|function|interface|class|enum)\s+([A-Za-z0-9_]+)/;

/** Slice each named declaration from its start line to the line before the next
 * top-level declaration (file order, not `declNames` order) — brace-agnostic,
 * so deep nesting and union/arrow bodies don't need brace balancing. */
export function extractDeclarations(source: string, declNames: readonly string[], label: string): string {
  const lines = source.split("\n");
  const starts: { name: string; line: number }[] = [];
  lines.forEach((line, i) => {
    const m = DECL_RE.exec(line);
    if (m?.[1]) starts.push({ name: m[1], line: i });
  });

  const out: string[] = [];
  for (const name of declNames) {
    const start = starts.find((s) => s.name === name)?.line;
    if (start === undefined) {
      throw new Error(`${label}: declaration '${name}' not found in source — was it renamed?`);
    }
    const end = starts.reduce((acc, s) => (s.line > start && s.line < acc ? s.line : acc), lines.length);
    out.push(`### ${name}\n${lines.slice(start, end).join("\n")}`);
  }
  return out.join("\n");
}

/** Strip comments and collapse whitespace so the hash tracks structure only —
 * comment/format edits don't trip it; names, types, and optionality do. */
export function normalizeSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface SourceHashGateOptions {
  /** File whose declarations are hashed. */
  srcPath: string;
  /** Declaration names that make up the gated surface. */
  declNames: readonly string[];
  /** `{ version, hash }` snapshot file. */
  snapshotPath: string;
  /** Setting this env var to `"1"` re-snapshots instead of asserting. */
  envVar: string;
  /** The version constant the snapshot must agree with. */
  version: number;
  /** Short label prefixing every thrown message (e.g. `"ir-converters"`). */
  errorPrefix: string;
  /** Multi-line guidance appended to a hash-mismatch error. */
  bumpHint: string;
}

/** Run the gate. Re-snapshots and returns when `envVar === "1"`; otherwise
 * throws on a version mismatch or a hash drift. Call inside a `test(...)`. */
export function sourceHashGate(opts: SourceHashGateOptions): void {
  const src = readFileSync(opts.srcPath, "utf8");
  const hash = createHash("sha256")
    .update(normalizeSource(extractDeclarations(src, opts.declNames, opts.errorPrefix)))
    .digest("hex");

  if (process.env[opts.envVar] === "1") {
    writeFileSync(opts.snapshotPath, `${JSON.stringify({ version: opts.version, hash }, null, 2)}\n`);
    return;
  }

  const snap = JSON.parse(readFileSync(opts.snapshotPath, "utf8")) as { version: number; hash: string };

  // The snapshot's version moves WITH the code's — re-snapshotting a real
  // change without bumping (when a bump is due) is caught here.
  if (snap.version !== opts.version) {
    throw new Error(`${opts.errorPrefix}: snapshot version ${snap.version} does not match current ${opts.version}`);
  }

  if (hash !== snap.hash) {
    throw new Error(
      [
        `${opts.errorPrefix}: source hash changed`,
        `  snapshot ${snap.hash}`,
        `  current  ${hash}`,
        "",
        opts.bumpHint,
      ].join("\n"),
    );
  }
}
