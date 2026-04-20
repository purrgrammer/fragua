// Handler discipline — ARCHITECTURE.md §5.
//
// Handlers receive their I/O through HandlerContext (ctx.llm, ctx.http,
// ctx.tools, ctx.messages, ctx.artifacts, ctx.externalCall). Any handler
// that reaches directly for `fetch`, `undici`, `node:fs`, `node:child_process`,
// or `node:net` is breaking the invariant — the executor can't enforce
// AbortSignal, idempotency keys, or accounting on those paths.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const HANDLERS_DIR = join(__dirname, "..", "..", "src", "handler", "handlers");

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
});
