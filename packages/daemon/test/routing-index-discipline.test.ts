// Routing-index discipline — docs/proposals/typed-routing-struct.md §6.5.
//
// `run_state.routing` is a flat, dotted JSON dict. Every dispatch-driving read
// MUST route through the typed accessor module (`@fragua/core` routing.ts) so a
// mis-folded key degrades to a safe default instead of a wrong dispatch
// decision. This AST lint flags any element access (`x[...]`) or object
// destructuring (`const {…} = x`) on a binding whose name ends in
// `routing`/`Routing` (case-insensitive) or is annotated `RoutingDict`, across
// every workspace `src/` tree, with two sanctioned exceptions:
//
//   1. the accessor module itself (`packages/core/src/routing.ts`), and
//   2. lines marked `// routing-index-allow: <reason>` (the reducer's frontier
//      write, the executor's dynamic-key retry-count fold).
//
// Unlike the old substring scan, a camelCase binding like `effectiveRouting[k]`
// or a destructuring of `initialRouting` can no longer slip past by renaming.

import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  allowMarked,
  collectDestructurings,
  collectElementAccess,
  lineOf,
  parseSource,
  typedBindings,
} from "@fragua/test-utils";
import ts from "typescript";

const WORKSPACE_ROOT = join(import.meta.dir, "..", "..");
const ALLOW_MARKER = "routing-index-allow:";
const ACCESSOR_MODULE = join(WORKSPACE_ROOT, "core", "src", "routing.ts");
const ROUTING_NAME = /routing$/i;
const ROUTING_TYPE = "RoutingDict";

function isRoutingBinding(name: string | undefined, typed: Set<string>): boolean {
  return name !== undefined && (ROUTING_NAME.test(name) || typed.has(name));
}

function scan(sf: ts.SourceFile): number[] {
  const typed = typedBindings(sf, ROUTING_TYPE);
  const offenders: number[] = [];
  for (const ea of collectElementAccess(sf)) {
    if (isRoutingBinding(ea.objectName, typed) && !allowMarked(sf, ea.node, ALLOW_MARKER)) {
      offenders.push(lineOf(sf, ea.node));
    }
  }
  for (const d of collectDestructurings(sf)) {
    if (isRoutingBinding(d.initName, typed) && !allowMarked(sf, d.node, ALLOW_MARKER)) {
      offenders.push(lineOf(sf, d.node));
    }
  }
  return offenders.sort((a, b) => a - b);
}

function scanString(src: string): number[] {
  return scan(ts.createSourceFile("synthetic.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

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
    if (statSync(full).isDirectory()) out.push(...listSrcFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function packageSrcDirs(): string[] {
  return readdirSync(WORKSPACE_ROOT)
    .map((p) => join(WORKSPACE_ROOT, p, "src"))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

describe("routing-index discipline", () => {
  test("no raw routing element-access / destructuring outside the accessor module", () => {
    const offenders: string[] = [];
    for (const dir of packageSrcDirs()) {
      for (const file of listSrcFiles(dir)) {
        if (file === ACCESSOR_MODULE) continue;
        for (const line of scan(parseSource(file))) offenders.push(`${relative(WORKSPACE_ROOT, file)}:${line}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `Raw routing[...] access outside the accessor module (route through @fragua/core routing.ts` +
          ` accessors, or mark a justified seam with \`// ${ALLOW_MARKER} <reason>\`):\n${offenders.map((o) => `  ${o}`).join("\n")}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("catches effectiveRouting[...] and initialRouting[...] (the camelCase blind spot)", () => {
    expect(scanString(`const v = effectiveRouting["inputs"];\n`)).toEqual([1]);
    expect(scanString(`initialRouting["inputs"] = x;\n`)).toEqual([1]);
    expect(scanString(`const v = state.routing[k];\n`)).toEqual([1]);
  });

  test("catches destructuring of a routing binding", () => {
    expect(scanString(`const { inputs } = effectiveRouting;\n`)).toEqual([1]);
  });

  test("catches element access on a RoutingDict-typed binding", () => {
    // The `RoutingDict` type does not exist today; the check is dormant but
    // future-proof against a typed alias being introduced later.
    expect(scanString(`const r: RoutingDict = {}; const v = r[k];\n`)).toEqual([1]);
  });

  test("ignores non-routing-suffixed identifiers", () => {
    expect(scanString(`const v = routingPatch["k"];\n`)).toHaveLength(0);
    expect(scanString(`const v = arr[0];\n`)).toHaveLength(0);
  });

  test("honors the routing-index-allow marker (same line and line above)", () => {
    expect(scanString(`next.routing[KEY] = x; // ${ALLOW_MARKER} reducer frontier write\n`)).toHaveLength(0);
    expect(scanString(`// ${ALLOW_MARKER} reducer frontier write\nnext.routing[KEY] = x;\n`)).toHaveLength(0);
  });
});
