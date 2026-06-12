// Handler discipline — ARCHITECTURE.md §5.
//
// Handlers receive their I/O through HandlerContext (ctx.llm, ctx.http,
// ctx.tools, ctx.messages, ctx.artifacts, ctx.externalCall). Any handler
// that reaches directly for `fetch`, `undici`, `node:fs`, `node:child_process`,
// or `node:net` is breaking the invariant — the executor can't enforce
// AbortSignal, idempotency keys, or accounting on those paths.
//
// Browser safety: @fragua/core's MAIN entry must stay browser-safe — no
// `node:*` imports anywhere reachable from src/index.ts. The server-only
// sub-entries (`handler/`, `intent-plane/`, `read-plane/`) are exempt; they
// are imported via their own entry points and excluded from the web bundle.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = join(__dirname, "..", "..", "src");
const HANDLERS_DIR = join(SRC_DIR, "handler", "handlers");

// Server-only sub-entries declared in package.json exports; everything else
// under src/ is reachable from the browser-safe main entry.
const SERVER_ONLY_DIRS = new Set(["handler", "intent-plane", "read-plane"]);

const BANNED = [
  {
    id: "undici",
    pattern: /\bfrom\s+["']undici["']/,
    reason: "go through ctx.http instead",
  },
  {
    id: "node:fs",
    pattern: /\bfrom\s+["']node:fs(\/.*)?["']/,
    reason: "handlers are pure; persist via ctx.artifacts",
  },
  {
    id: "node:child_process",
    pattern: /\bfrom\s+["']node:child_process["']/,
    reason: "handlers must not spawn processes",
  },
  {
    id: "node:net",
    pattern: /\bfrom\s+["']node:net["']/,
    reason: "use ctx.http for network I/O",
  },
  {
    id: "raw fetch",
    // Bare `fetch(` call not preceded by `ctx.http.` — heuristic
    pattern: /(^|[^.\w])fetch\s*\(/,
    reason: "use ctx.http.fetch so AbortSignal propagates",
  },
];

function* collect(root: string): Iterable<string> {
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* collect(full);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) yield full;
  }
}

function scan(source: string): { rule: string; line: number }[] {
  const offenders: { rule: string; line: number }[] = [];
  const lines = source.split("\n");
  for (const banned of BANNED) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      if (banned.pattern.test(line)) {
        offenders.push({ rule: banned.id, line: i + 1 });
      }
    }
  }
  return offenders;
}

describe("handler discipline", () => {
  test("no banned imports or raw fetch in handlers/", () => {
    const offenders: { file: string; rule: string; line: number; reason: string }[] = [];
    for (const file of collect(HANDLERS_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const hit of scan(src)) {
        const rule = BANNED.find((b) => b.id === hit.rule)!;
        offenders.push({
          file,
          rule: hit.rule,
          line: hit.line,
          reason: rule.reason,
        });
      }
    }
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line} → ${o.rule} (${o.reason})`).join("\n");
      throw new Error(`Handler discipline violations:\n${msg}`);
    }
    expect(offenders).toHaveLength(0);
  });

  // sideEffect: "external" is the contract that the startup sweep uses to
  // quarantine orphaned intent/done pairs after a crash (ARCHITECTURE.md
  // §1.1, §5). If a handler declares itself external but never calls
  // ctx.externalCall, the intent/done facts never get written, the sweep
  // finds nothing to quarantine, and replay silently double-executes.
  test('every sideEffect:"external" handler in handlers/ uses ctx.externalCall', () => {
    const externalRe = /sideEffect\s*:\s*["']external["']/;
    const usesRe = /\bctx\.externalCall\s*\(/;
    const offenders: string[] = [];
    for (const file of collect(HANDLERS_DIR)) {
      const src = readFileSync(file, "utf8");
      if (externalRe.test(src) && !usesRe.test(src)) offenders.push(file);
    }
    if (offenders.length > 0) {
      throw new Error(
        `Handlers declaring sideEffect:"external" must call ctx.externalCall:\n` +
          offenders.map((f) => `  ${f}`).join("\n"),
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("lint catches raw fetch in a synthetic handler source", () => {
    const bad = `
      export async function evil() {
        const res = await fetch("https://example.test");
        return res.json();
      }
    `;
    const hits = scan(bad);
    expect(hits.some((h) => h.rule === "raw fetch")).toBe(true);
  });

  test("lint catches node:fs import", () => {
    const bad = `import { readFileSync } from "node:fs";\n`;
    const hits = scan(bad);
    expect(hits.some((h) => h.rule === "node:fs")).toBe(true);
  });

  test("ctx.http.fetch is not flagged", () => {
    const ok = `const res = await ctx.http.fetch("https://example.test");\n`;
    const hits = scan(ok);
    expect(hits.some((h) => h.rule === "raw fetch")).toBe(false);
  });

  test("external-without-externalCall check matches a synthetic bad handler", () => {
    const externalRe = /sideEffect\s*:\s*["']external["']/;
    const usesRe = /\bctx\.externalCall\s*\(/;
    const bad = `export const spec = { kind: "x", sideEffect: "external", maxMs: 1, handler: async (ctx) => ({ kind: "halt", reason: "error" }) };`;
    expect(externalRe.test(bad) && !usesRe.test(bad)).toBe(true);
    const good = `export const spec = { kind: "x", sideEffect: "external", maxMs: 1, handler: async (ctx) => { await ctx.externalCall({ toolName: "t", args: {} }, async () => null); return { kind: "halt", reason: "error" }; } };`;
    expect(externalRe.test(good) && !usesRe.test(good)).toBe(false);
  });
});

// Any `node:` import — static, dynamic, or require — in browser-reachable code.
const NODE_IMPORT_RE = /\b(?:from\s+["']node:|import\s*\(\s*["']node:|require\s*\(\s*["']node:)/;

function scanNodeImports(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (NODE_IMPORT_RE.test(lines[i]!)) hits.push(i + 1);
  }
  return hits;
}

function* collectBrowserReachable(): Iterable<string> {
  for (const name of readdirSync(SRC_DIR)) {
    const full = join(SRC_DIR, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SERVER_ONLY_DIRS.has(name)) continue;
      yield* collect(full);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      yield full;
    }
  }
}

describe("browser safety — main entry has no node: imports", () => {
  test("no node: import reachable from src/index.ts", () => {
    const offenders: string[] = [];
    for (const file of collectBrowserReachable()) {
      const src = readFileSync(file, "utf8");
      for (const line of scanNodeImports(src)) {
        offenders.push(`  ${relative(SRC_DIR, file)}:${line}`);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `node: imports in browser-reachable @fragua/core code (main entry must stay browser-safe;\n` +
          `move the code under a server-only sub-entry or inject the dependency):\n${offenders.join("\n")}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("lint catches a static node: import", () => {
    expect(scanNodeImports(`import { readFileSync } from "node:fs";\n`)).toEqual([1]);
  });

  test("lint catches a dynamic node: import and require", () => {
    expect(scanNodeImports(`const fs = await import("node:fs");\n`)).toEqual([1]);
    expect(scanNodeImports(`const fs = require("node:child_process");\n`)).toEqual([1]);
  });

  test("lint ignores commented-out imports", () => {
    expect(scanNodeImports(`// import { join } from "node:path";\n`)).toEqual([]);
  });
});
