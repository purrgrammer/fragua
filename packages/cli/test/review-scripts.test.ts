// The review pack's two deterministic steps — `resolve` and `post` — replaced
// `llm` relays, so their routing tables are now shell, not prose. That is the
// point: grep's exit code IS the decision. It also means a regex edit can move
// a verdict without anything typechecking, and one already did — a widened
// `post-review.sh` pattern set approved a `review_quick` body carrying a
// Critical finding, because the patterns only knew `synthesize`'s shape.
//
// So the tables get pinned by execution, not by reading. Each case below runs
// the real script against a real body/target and asserts the decision it
// reaches. `gh` is stubbed on PATH so no case can reach GitHub.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const postReview = join(root, ".fragua/scripts/review/post-review.sh");
const resolveTarget = join(root, ".fragua/scripts/review/resolve-target.sh");

/** A throwaway cwd with a `gh` stub first on PATH, recording its argv. */
function sandbox(): { dir: string; env: NodeJS.ProcessEnv; ghArgs: () => string[] } {
  const dir = mkdtempSync(join(tmpdir(), "review-scripts-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "gh.log");
  // `gh pr view --json url` must print something parseable; everything else
  // just records that it was called.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n` +
      `if [ "\${2-}" = view ]; then echo "https://example.test/pr"; fi\nexit 0\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  return {
    dir,
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    ghArgs: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

interface Run {
  status: number;
  outputs: Record<string, unknown> | undefined;
  stderr: string;
}

function runScript(script: string, args: string[], sb: ReturnType<typeof sandbox>): Run {
  const outPath = join(sb.dir, "out.json");
  const r = spawnSync("bash", [script, ...args], {
    cwd: sb.dir,
    env: { ...sb.env, FRAGUA_OUTPUT: outPath },
    encoding: "utf8",
  });
  let outputs: Record<string, unknown> | undefined;
  try {
    outputs = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, unknown>;
  } catch {
    outputs = undefined;
  }
  return { status: r.status ?? -1, outputs, stderr: r.stderr };
}

describe("post-review.sh — the severity routing table", () => {
  // The whole table in one place: body shape ⇒ what reaches `gh pr review`.
  // `unreadable` is the load-bearing row — approval must never be the
  // fallthrough for a shape the script does not recognise.
  const cases: ReadonlyArray<[label: string, body: string, verb: string, verdict: string]> = [
    ["synthesize Critical", "## Defects\n\n### Critical\n\nboom\n", "--request-changes", "blocking"],
    ["synthesize High", "## Defects\n\n### High\n\nboom\n", "--request-changes", "blocking"],
    ["quick critical bullet", "## Findings\n\n- [critical] a.ts:1 boom\n", "--request-changes", "blocking"],
    ["quick high bullet", "## Findings\n\n- [high] a.ts:1 boom\n", "--request-changes", "blocking"],
    ["findings, none blocking", "## Findings\n\n- [medium] a.ts:1 meh\n", "--comment", "non-blocking"],
    ["improvements only", "## Improvements\n\nrename it\n", "--comment", "non-blocking"],
    ["explicit all clear", "## All clear\n\nnothing found\n", "--approve", "approve"],
    ["novel template", "# Review\n\nLooks fine to me.\n", "--request-changes", "unreadable"],
    ["truncated write", "## Sco", "--request-changes", "unreadable"],
  ];

  for (const [label, body, verb, verdict] of cases) {
    test(`${label} ⇒ ${verb}`, () => {
      const sb = sandbox();
      writeFileSync(join(sb.dir, "review.md"), body);

      const r = runScript(postReview, ["42"], sb);

      expect(r.status).toBe(0);
      expect(r.outputs).toMatchObject({ verdict, url: "https://example.test/pr" });
      expect(sb.ghArgs().some((a) => a.includes(`pr review 42 ${verb}`))).toBe(true);
    });
  }

  test("an empty review.md posts nothing at all and fails the node", () => {
    const sb = sandbox();
    writeFileSync(join(sb.dir, "review.md"), "");

    const r = runScript(postReview, ["42"], sb);

    // Exit 3, no struct, and — the part that matters — no `gh pr review`.
    expect(r.status).toBe(3);
    expect(r.outputs).toBeUndefined();
    expect(sb.ghArgs().some((a) => a.includes("pr review"))).toBe(false);
  });

  test("no PR is a complete local outcome, not a failure", () => {
    const sb = sandbox();
    const r = runScript(postReview, ["none"], sb);

    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({ posted: "none", verdict: "local", url: "" });
    expect(sb.ghArgs()).toEqual([]);
  });

  test("a non-numeric PR argument is rejected before any gh call", () => {
    const sb = sandbox();
    writeFileSync(join(sb.dir, "review.md"), "## All clear\n");

    const r = runScript(postReview, ["42; rm -rf /"], sb);

    expect(r.status).toBe(2);
    expect(sb.ghArgs()).toEqual([]);
  });
});

describe("resolve-target.sh — classification, first match wins", () => {
  test("an empty target resolves to nothing rather than to everything", () => {
    const sb = sandbox();
    const r = runScript(resolveTarget, [""], sb);

    expect(r.status).toBe(1);
    expect(r.outputs).toBeUndefined();
  });

  test("existing paths list as FILES with no diff spec", () => {
    const sb = sandbox();
    writeFileSync(join(sb.dir, "a.ts"), "");
    writeFileSync(join(sb.dir, "b.ts"), "");

    const r = runScript(resolveTarget, ["a.ts b.ts"], sb);

    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({ pr: "none", diff_spec: "", paths: ["a.ts", "b.ts"] });
  });

  test("a glob expands — documented, and pinned here so it stays deliberate", () => {
    // The word-split at the FILES branch is intentional (space-separated
    // paths), and so is the globbing that rides along with it: the header
    // contract says "an existing path OR GLOB". A reviewer read the same line
    // as a defect, so the behaviour is asserted rather than argued — `*`
    // enumerates the cwd, which is what `*` means.
    const sb = sandbox();
    writeFileSync(join(sb.dir, "a.ts"), "");
    writeFileSync(join(sb.dir, "b.ts"), "");

    const r = runScript(resolveTarget, ["*.ts"], sb);

    expect(r.status).toBe(0);
    expect(r.outputs?.["paths"]).toEqual(["a.ts", "b.ts"]);
  });

  test("an unmatched glob is not a path, so it falls through and cannot resolve", () => {
    const sb = sandbox();
    const r = runScript(resolveTarget, ["nope*.ts"], sb);

    expect(r.status).toBe(2);
    expect(r.outputs).toBeUndefined();
  });
});

describe("resolve-target.sh — PR number parsing", () => {
  // `PR 42`, `#42` and a bare `42` are the three spellings the header
  // promises. Each must reach resolve-pr.sh with 42 and nothing else.
  for (const spelling of ["PR 42", "pr 42", "#42", "42", "PR  42"]) {
    test(`${JSON.stringify(spelling)} is PR 42`, () => {
      const sb = sandbox();
      // resolve-pr.sh is not stubbed, so the call fails — but it fails AFTER
      // parsing, and a parse rejection exits 2 before ever getting there.
      const r = runScript(resolveTarget, [spelling], sb);
      expect(r.status).not.toBe(2);
    });
  }

  for (const bad of ["PR 4x2", "PR ", "#", "PR abc"]) {
    test(`${JSON.stringify(bad)} is rejected, not coerced to a nearby number`, () => {
      const sb = sandbox();
      const r = runScript(resolveTarget, [bad], sb);
      expect(r.status).toBe(2);
      expect(r.outputs).toBeUndefined();
    });
  }
});
