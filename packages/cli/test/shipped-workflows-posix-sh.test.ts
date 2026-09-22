// A `tool` step's `run:` is executed as `/bin/sh -c <command>`
// (docs/execution-model.md §2, `LocalEnvironment.exec`). On macOS `/bin/sh` is
// bash in POSIX mode and tolerates bashisms; on Linux it is dash and does not.
// So a bash-only construct in a shipped workflow passes every local run and
// then aborts in CI — which is exactly how `set -euo pipefail` in drift.yaml
// reached main and broke the weekly Doc drift job with
// `/bin/sh: 1: set: Illegal option -o pipefail`.
//
// `fragua validate` can't catch this: the run body is opaque to the parser.
// Hence a source scan, in the shape of the other lint tests.
//
// Needing bash is legitimate — say so explicitly by invoking it
// (`run: bash .fragua/scripts/foo.sh`), which moves the bashisms into a file
// with its own shebang and out of the `/bin/sh` body.

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "@fragua/core";

const workflowsDir = join(import.meta.dir, "../../../.fragua/workflows");
const files = readdirSync(workflowsDir)
  .filter((f) => f.endsWith(".yaml"))
  .sort();

/** Constructs `/bin/sh` (dash) rejects or silently misreads. */
const BASHISMS: ReadonlyArray<{ re: RegExp; name: string; posix: string }> = [
  {
    re: /\bset\s+[-a-z]*\s*-o\s+pipefail\b|\bset\s+-[a-z]*o\s+pipefail\b/,
    name: "set -o pipefail",
    posix: "drop it (`set -eu`); with a real pipeline, check the producer's status explicitly",
  },
  { re: /\[\[/, name: "[[ ]]", posix: "use [ ] / test" },
  { re: /<<</, name: "here-string", posix: "use printf ... | cmd" },
  { re: /\bfunction\s+\w+\s*(\(|\{)/, name: "function keyword", posix: "use name() { ... }" },
  { re: /\becho\s+-e\b/, name: "echo -e", posix: "use printf" },
  { re: /(^|[^0-9>])&>/, name: "&> redirect", posix: "use > file 2>&1" },
  { re: /^\s*local\s+\w/, name: "local", posix: "not POSIX — use a distinct variable name" },
  { re: /^\s*source\s+\S/, name: "source", posix: "use . (dot)" },
];

/** Strip whole-line `#` comments — prose about a bashism is not a bashism. */
function codeLines(command: string): Array<{ n: number; text: string }> {
  return command
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => text.trim() !== "" && !text.trim().startsWith("#"));
}

describe("shipped workflows — tool `run:` bodies are POSIX sh", () => {
  test("there is at least one tool step to check", async () => {
    let total = 0;
    for (const file of files) {
      const src = await Bun.file(join(workflowsDir, file)).text();
      total += Object.values(parseWorkflow(src).nodes).filter((n) => n.type === "tool").length;
    }
    expect(total).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} uses no bashisms in a tool run: body`, async () => {
      const src = await Bun.file(join(workflowsDir, file)).text();
      const graph = parseWorkflow(src);
      const hits: string[] = [];
      for (const [nodeId, node] of Object.entries(graph.nodes)) {
        if (node.type !== "tool") continue;
        const command = String((node.attrs as { tool_command?: unknown }).tool_command ?? "");
        for (const { n, text } of codeLines(command)) {
          for (const { re, name, posix } of BASHISMS) {
            if (re.test(text)) hits.push(`${file} step "${nodeId}" line ${n}: ${name} — ${posix}\n    ${text.trim()}`);
          }
        }
      }
      expect(hits).toEqual([]);
    });
  }
});

describe("the bashism scan itself", () => {
  test("flags the construct that broke the Doc drift job", () => {
    const hit = BASHISMS.find(({ re }) => re.test("      set -euo pipefail"));
    expect(hit?.name).toBe("set -o pipefail");
  });

  test("does not flag the POSIX replacement, nor an explicit `bash script.sh`", () => {
    for (const line of [
      "      set -eu",
      "bash .fragua/scripts/drift/open-pr.sh true",
      '  jq -e . "$out/x.json" > /dev/null',
      'head -c 8192 -- "$f" >> "$out/p.diff" || true',
      "git diff 2>&1 > /dev/null",
    ]) {
      expect(BASHISMS.filter(({ re }) => re.test(line)).map((b) => b.name)).toEqual([]);
    }
  });
});
