// Decision-core purity discipline.
//
// The executor's decision core MUST be a set of pure functions of their
// declared inputs: given the same arguments they return the same plan, with
// no hidden reads of wall-clock time, randomness, the filesystem, the network,
// or a store/db handle. Time and randomness are threaded in explicitly (`now`,
// `random`) so a replay or a fault-injecting test gets bit-identical output.
//
// This lint scans the decision-core source files and fails if any ambient
// source of nondeterminism / IO appears: Date.now, new Date()/Date(),
// Math.random, a raw fetch, or a node:fs / node:child_process import. The
// documented escape for a justified seam (e.g. the lone injection default) is
// the marker `// decision-core-allow: <reason>` on the offending line or the
// line directly above it.
//
// Shape mirrors packages/core/test/handler/discipline.test.ts and
// packages/server/test/inline-import-discipline.test.ts (source-scan lint).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src");
const ALLOW_MARKER = "decision-core-allow:";

// The decision-core files. Each must be a pure function of its declared
// inputs. executor-helpers.ts holds the pure leaf projections alongside some
// timer glue (sleep/armTimeout) — that glue uses setTimeout, which is not a
// banned token here, so the whole file is linted without an exclusion.
const DECISION_CORE_FILES = [
  "transition-planner.ts",
  "abort-planner.ts",
  "result-to-facts.ts",
  "provider-retry-policy.ts",
  "executor-helpers.ts",
];

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
    for (const name of DECISION_CORE_FILES) {
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
