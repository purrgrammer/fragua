// Decision-core purity discipline.
//
// The executor's decision core MUST be a set of pure functions of their
// declared inputs: given the same arguments they return the same plan, with
// no hidden reads of wall-clock time, randomness, the filesystem, the network,
// or a store/db handle. Time and randomness are threaded in explicitly (`now`,
// `random`) so a replay or a fault-injecting test gets bit-identical output.
//
// This lint SCANS every file under packages/daemon/src and fails if any
// ambient source of nondeterminism / IO appears: Date.now, new Date()/Date(),
// Math.random, a raw fetch, a node:fs / node:child_process import, or a
// @fragua/store / bun:sqlite (store/db handle) import. Files are guarded by
// default — a new pure planning module is covered the moment it lands, with
// no static include list to update. Files that legitimately do I/O (the
// executor, supervisor, recorder, provisioner, and the like) opt OUT through
// the explicit, named IO_ALLOWED exclusion list below.
//
// The documented escape for a justified seam on an otherwise-pure file (e.g.
// the lone injection default) is the marker `// decision-core-allow: <reason>`
// on the offending line or the line directly above it.
//
// Shape mirrors packages/core/test/handler/discipline.test.ts and
// packages/server/test/inline-import-discipline.test.ts (source-scan lint).

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");
const ALLOW_MARKER = "decision-core-allow:";

// I/O-allowed files: these run the engine's side effects (store appends,
// process spawning, filesystem, timers tied to wall-clock, abort wiring) and
// are exempt from the purity scan. Everything else under src/ — including any
// new pure planning module — IS scanned. To exempt a new file you must name it
// here explicitly, which forces the "is this really allowed to do I/O?"
// decision instead of letting a store handle slip into the decision core.
const IO_ALLOWED = new Set<string>([
  "abort-registry.ts",
  "auto-dispatcher.ts",
  "auto-titler.ts",
  "blob-gc.ts",
  "entrypoint.ts",
  "executor.ts",
  "graph-loader.ts",
  "index.ts",
  "invoke-handler.ts",
  "occ-append.ts",
  "operator-actions.ts",
  "recorder.ts",
  "schedule-dispatcher.ts",
  "snapshot-service.ts",
  "snapshotter.ts",
  "supervisor.ts",
  "wake-pending.ts",
  "worktree-provisioner.ts",
]);

function decisionCoreFiles(): string[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .filter((name) => !IO_ALLOWED.has(name))
    .sort();
}

const BANNED = [
  {
    id: "Date.now",
    pattern: /\bDate\.now\s*\(/,
    reason: "thread wall-clock in as the `now` parameter",
  },
  {
    id: "Date constructor",
    // `new Date(...)` or a bare `Date(...)` call; `Date.now` is its own rule.
    pattern: /\bnew\s+Date\b|(^|[^.\w])Date\s*\(/,
    reason: "thread wall-clock in as the `now` parameter",
  },
  {
    id: "Math.random",
    pattern: /\bMath\.random\b/,
    reason: "thread randomness in as the `random` parameter",
  },
  {
    id: "raw fetch",
    pattern: /(^|[^.\w])fetch\s*\(/,
    reason: "decision core does no I/O",
  },
  {
    id: "node:fs",
    pattern: /\bfrom\s+["'](?:node:)?fs(\/.*)?["']/,
    reason: "decision core does no filesystem I/O",
  },
  {
    id: "node:child_process",
    pattern: /\bfrom\s+["'](?:node:)?child_process["']/,
    reason: "decision core must not spawn processes",
  },
  {
    id: "bun:sqlite import",
    // The sqlite driver (and its Database handle) is never a pure input.
    pattern: /\bfrom\s+["']bun:sqlite["']/,
    reason: "decision core must not reach the sqlite driver — fold plain FactEvent / RunState inputs instead",
  },
  {
    id: "store handle import",
    // A store/db HANDLE type smuggled in through an input — even type-only —
    // gives the decision core a live read/write surface. The pure-data event
    // and state types (FactEvent, RunState, …) stay allowed; only the handle
    // types are banned. Matched on a single import line (the daemon writes
    // these one per line, mirroring the rest of this line-based lint).
    pattern:
      /\b(?:IEventStore|IEventReader|IEventWriter|EventStore|Database)\b[^;]*\bfrom\s+["'](?:@fragua\/store|bun:sqlite)["']/,
    reason: "decision core must not reach a store/db handle — keep it a pure function of plain inputs",
  },
];

function scan(source: string): { rule: string; line: number }[] {
  const offenders: { rule: string; line: number }[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    // Split off a trailing line-comment: a banned token named in an inline
    // comment (a rationale) must not false-positive, and the allow-marker is
    // honoured only inside a comment token, never a string literal.
    const commentIdx = line.indexOf("//");
    const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";
    if (comment.includes(ALLOW_MARKER)) continue;
    const prevTrimmed = i > 0 ? lines[i - 1]!.trimStart() : "";
    if (prevTrimmed.startsWith("//") && prevTrimmed.includes(ALLOW_MARKER)) continue;
    for (const banned of BANNED) {
      if (banned.pattern.test(code)) offenders.push({ rule: banned.id, line: i + 1 });
    }
  }
  return offenders;
}

describe("decision-core purity discipline", () => {
  test("no ambient time / randomness / IO in the decision-core files", () => {
    const offenders: { file: string; rule: string; line: number; reason: string }[] = [];
    for (const name of decisionCoreFiles()) {
      const file = join(SRC_DIR, name);
      const src = readFileSync(file, "utf8");
      for (const hit of scan(src)) {
        const rule = BANNED.find((b) => b.id === hit.rule)!;
        offenders.push({ file: relative(SRC_DIR, file), rule: hit.rule, line: hit.line, reason: rule.reason });
      }
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line} → ${o.rule} (${o.reason})`).join("\n");
      throw new Error(
        `Decision-core purity violations (inject the dependency, or mark a justified seam with` +
          ` \`// ${ALLOW_MARKER} <reason>\`):\n${msg}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("lint catches Date.now()", () => {
    const hits = scan(`const t = Date.now();\n`);
    expect(hits.some((h) => h.rule === "Date.now")).toBe(true);
  });

  test("lint catches new Date()", () => {
    const hits = scan(`const d = new Date();\n`);
    expect(hits.some((h) => h.rule === "Date constructor")).toBe(true);
  });

  test("lint catches Math.random()", () => {
    const hits = scan(`const r = Math.random();\n`);
    expect(hits.some((h) => h.rule === "Math.random")).toBe(true);
  });

  test("lint catches a raw fetch", () => {
    const hits = scan(`const res = await fetch("https://example.test");\n`);
    expect(hits.some((h) => h.rule === "raw fetch")).toBe(true);
  });

  test("lint catches node:fs and bare fs imports", () => {
    expect(scan(`import { readFileSync } from "node:fs";\n`).some((h) => h.rule === "node:fs")).toBe(true);
    expect(scan(`import { readFileSync } from "fs";\n`).some((h) => h.rule === "node:fs")).toBe(true);
  });

  test("lint catches node:child_process imports", () => {
    expect(scan(`import { spawn } from "node:child_process";\n`).some((h) => h.rule === "node:child_process")).toBe(
      true,
    );
  });

  test("lint catches a store/db handle import", () => {
    expect(
      scan(`import type { IEventStore } from "@fragua/store";\n`).some((h) => h.rule === "store handle import"),
    ).toBe(true);
    expect(scan(`import { Database } from "bun:sqlite";\n`).some((h) => h.rule === "bun:sqlite import")).toBe(true);
    expect(
      scan(`import type { IEventReader, IEventWriter } from "@fragua/store";\n`).some(
        (h) => h.rule === "store handle import",
      ),
    ).toBe(true);
  });

  test("lint allows pure-data event/state type imports from @fragua/store", () => {
    expect(scan(`import type { FactEvent, RunState } from "@fragua/store";\n`)).toHaveLength(0);
    expect(scan(`import { SETTLED_STATUSES } from "@fragua/store";\n`)).toHaveLength(0);
  });

  test("fanout-planner.ts is covered by the scan", () => {
    expect(decisionCoreFiles()).toContain("fanout-planner.ts");
  });

  test("the scan walks the directory rather than a static include list", () => {
    // A documented-pure module added tomorrow is guarded automatically: it is
    // scanned unless it is named on the IO_ALLOWED exclusion list.
    const scanned = decisionCoreFiles();
    expect(scanned).toContain("transition-planner.ts");
    for (const name of scanned) expect(IO_ALLOWED.has(name)).toBe(false);
  });

  test("the IO_ALLOWED exclusion list names only files that exist", () => {
    const present = new Set(readdirSync(SRC_DIR));
    for (const name of IO_ALLOWED) expect(present.has(name)).toBe(true);
  });

  test("lint honors the decision-core-allow marker", () => {
    const sameLine = `const r = Math.random(); // ${ALLOW_MARKER} injection default\n`;
    expect(scan(sameLine)).toHaveLength(0);
    const lineAbove = `// ${ALLOW_MARKER} injection default\nconst r = Math.random();\n`;
    expect(scan(lineAbove)).toHaveLength(0);
  });

  test("lint ignores commented-out occurrences", () => {
    expect(scan(`// const t = Date.now();\n`)).toHaveLength(0);
  });

  test("the injected `now`/`random` parameters are not flagged", () => {
    expect(scan(`const at = opts.now + delayMs;\n`)).toHaveLength(0);
    expect(scan(`return Math.floor(random() * cap);\n`)).toHaveLength(0);
  });
});
