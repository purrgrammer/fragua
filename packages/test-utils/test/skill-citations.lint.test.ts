// Source-scan lint — AGENTS.md ground rule 7 ("NO SKILL CITATIONS IN CODE").
//
// A comment that cites a skill file (`// SKILL.md § …`, `/* SKILL.md`, or a
// `.agents/skills/<name>` pointer used to justify a rule) rots silently the
// moment the cited skill is edited. Skills load on demand; a comment must
// explain the WHY directly rather than point at one. This walks every
// `packages/*/src` tree and fails on such a citation inside a comment.
//
// Scope: comments only (string/JSX literals that legitimately reference the
// skills subsystem's own paths are not comments and don't match). Test files
// are excluded — they may fixture skill paths as data.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = join(__dirname, "..", "..");

/**
 * Files trusted to reference a skill path inside a comment because they are
 * the skills subsystem itself describing its own on-disk layout — not a
 * citation of a rule. Each entry needs a reason.
 */
const ALLOWLIST = new Map<string, string>([
  [
    "packages/server/src/store/skills-routes.ts",
    "skills subsystem: documents the ~/.agents/skills/ discovery path it serves",
  ],
  [
    "packages/workspace/src/skills/types.ts",
    "skills subsystem: documents the ~/.agents/skills/ discovery path in the type",
  ],
  [
    "packages/workspace/src/local-env.ts",
    "path-escape example: a literal write target that escaped cwd, not a rule citation",
  ],
]);

function collectSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Every comment body in a source file: block comments then line comments. */
function comments(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\/\*[\s\S]*?\*\//g)) out.push(m[0]);
  for (const m of source.matchAll(/\/\/[^\n]*/g)) out.push(m[0]);
  return out;
}

const CITATION = /SKILL\.md\s*§|\.agents\/skills\//;

function packageSrcRoots(): string[] {
  const roots: string[] = [];
  for (const name of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, name, "src");
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      // package without a src/ dir — skip
    }
  }
  return roots;
}

describe("no skill citations in code (AGENTS.md ground rule 7)", () => {
  const offenders: { file: string; snippet: string }[] = [];
  for (const root of packageSrcRoots()) {
    for (const file of collectSources(root)) {
      const rel = file.slice(join(PACKAGES, "..").length + 1);
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      for (const comment of comments(src)) {
        if (CITATION.test(comment)) {
          offenders.push({ file: rel, snippet: comment.trim().slice(0, 100) });
        }
      }
    }
  }

  test("no offenders", () => {
    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}\n    ${o.snippet}`).join("\n");
      throw new Error(
        `Skill citations found in source comments. Explain the WHY directly instead of pointing at a skill:\n${msg}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test("allowlist entries still exist and still match (no stale exemptions)", () => {
    for (const [rel, reason] of ALLOWLIST) {
      expect(reason.length).toBeGreaterThan(0);
      const src = readFileSync(join(PACKAGES, "..", rel), "utf8");
      const matches = comments(src).some((c) => CITATION.test(c));
      expect(matches, `allowlisted ${rel} no longer cites a skill path — drop it`).toBe(true);
    }
  });
});
