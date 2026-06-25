// Routing-index discipline — docs/proposals/typed-routing-struct.md §6.5.
//
// `run_state.routing` is a flat, dotted JSON dict. Every dispatch-driving read
// MUST route through the typed accessor module (`@fragua/core` routing.ts) so a
// mis-folded key degrades to a safe default instead of a wrong dispatch
// decision. This lint bans raw `routing[...]` / `.routing[...]` indexing across
// the workspace `src/` trees, with exactly two sanctioned exceptions:
//
//   1. the accessor module itself (`packages/core/src/routing.ts`), and
//   2. the reducer's frontier WRITE (`packages/store/src/reducers.ts`), each
//      marked inline with `// routing-index-allow: reducer frontier write`.
//
// Any other raw index is a seam erosion. Mark a justified exception with
// `// routing-index-allow: <reason>` on the offending line or the line above.
//
// Shape mirrors packages/daemon/test/decision-core-discipline.test.ts.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WORKSPACE_ROOT = join(import.meta.dir, "..", "..");
const ALLOW_MARKER = "routing-index-allow:";

// The one file allowed to index `routing[...]` freely: the accessor module is
// the single seam every other reader routes through.
const ACCESSOR_MODULE = join(WORKSPACE_ROOT, "core", "src", "routing.ts");

// Match `routing[` or `.routing[` where "routing" is a standalone identifier
// (or property tail). A capitalised camelCase like `effectiveRouting[` or
// `routingPatch[` is NOT a match — only the bare `routing` binding / `.routing`
// property the accessors are meant to replace.
const PATTERN = /(?:^|[^A-Za-z0-9_$])routing\s*\[|\.routing\s*\[/;

function listSrcFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSrcFiles(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function packageSrcDirs(): string[] {
  const pkgs = readdirSync(WORKSPACE_ROOT).filter((p) => {
    try {
      return statSync(join(WORKSPACE_ROOT, p)).isDirectory();
    } catch {
      return false;
    }
  });
  return pkgs
    .map((p) => join(WORKSPACE_ROOT, p, "src"))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

function scan(source: string): number[] {
  const offenders: number[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const commentIdx = line.indexOf("//");
    const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";
    if (comment.includes(ALLOW_MARKER)) continue;
    const prevTrimmed = i > 0 ? lines[i - 1]!.trimStart() : "";
    if (prevTrimmed.startsWith("//") && prevTrimmed.includes(ALLOW_MARKER)) continue;
    if (PATTERN.test(code)) offenders.push(i + 1);
  }
  return offenders;
}

describe("routing-index discipline", () => {
  test("no raw routing[ / .routing[ indexing outside the accessor module", () => {
    const offenders: { file: string; line: number }[] = [];
    for (const dir of packageSrcDirs()) {
      for (const file of listSrcFiles(dir)) {
        if (file === ACCESSOR_MODULE) continue;
        const src = readFileSync(file, "utf8");
        for (const line of scan(src)) {
          offenders.push({ file: relative(WORKSPACE_ROOT, file), line });
        }
      }
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}`).join("\n");
      throw new Error(
        `Raw routing[...] indexing outside the accessor module (route through @fragua/core` +
          ` routing.ts accessors, or mark a justified seam with \`// ${ALLOW_MARKER} <reason>\`):\n${msg}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("lint catches a raw routing[ index", () => {
    expect(scan(`const v = routing["inputs"];\n`)).toEqual([1]);
    expect(scan(`const v = state.routing["x"];\n`)).toEqual([1]);
  });

  test("lint ignores camelCase routing-suffixed identifiers", () => {
    expect(scan(`const v = effectiveRouting["inputs"];\n`)).toHaveLength(0);
    expect(scan(`routingPatch["k"] = 1;\n`)).toHaveLength(0);
  });

  test("honors the routing-index-allow marker (same line and line above)", () => {
    expect(scan(`next.routing[KEY] = x; // ${ALLOW_MARKER} reducer frontier write\n`)).toHaveLength(0);
    expect(scan(`// ${ALLOW_MARKER} reducer frontier write\nnext.routing[KEY] = x;\n`)).toHaveLength(0);
  });

  test("lint ignores commented-out occurrences", () => {
    expect(scan(`// const v = routing["inputs"];\n`)).toHaveLength(0);
  });
});
