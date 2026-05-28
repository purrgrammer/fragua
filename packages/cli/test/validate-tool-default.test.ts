// Tests for `fragua validate` surfacing the default tool timeout.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCommand } from "../src/commands/validate.ts";

interface Rig {
  dir: string;
  write: (name: string, content: string) => string;
  close: () => void;
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "fragua-validate-"));
  return {
    dir,
    write: (name: string, content: string) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("fragua validate — tool default timeout info", () => {
  let r: Rig;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    r = rig();
    logs = [];
    errors = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
  });

  afterEach(() => {
    r.close();
  });

  const out = (): string => logs.join("\n");

  test("tool step without timeout-minutes → info diagnostic naming the step + default", async () => {
    const wf = r.write(
      "t.yaml",
      `name: test
steps:
  build:
    type: tool
    tool_command: "make build"
    next: done
  done:
    type: exit
`,
    );
    const code = await validateCommand(wf);
    expect(code).toBe(0);
    const o = out();
    // Should contain the step id
    expect(o).toContain("build");
    // Should mention the default timeout (5 minutes)
    expect(o).toContain("5");
    expect(o).toContain("timeout");
  });

  test("tool step with explicit timeout-minutes → no info diagnostic for that step", async () => {
    const wf = r.write(
      "t2.yaml",
      `name: test2
steps:
  build:
    type: tool
    tool_command: "make build"
    timeout-minutes: 10
    next: done
  done:
    type: exit
`,
    );
    const code = await validateCommand(wf);
    expect(code).toBe(0);
    const o = out();
    // No timeout info for this step
    expect(o).not.toContain("[timeout]");
  });

  test("llm step (not tool) → no timeout diagnostic", async () => {
    const wf = r.write(
      "t3.yaml",
      `name: test3
steps:
  plan:
    type: llm
    prompt: Do something
    next: done
  done:
    type: exit
`,
    );
    const code = await validateCommand(wf);
    expect(code).toBe(0);
    const o = out();
    expect(o).not.toContain("[timeout]");
  });

  test("tool step without timeout → ok diagnostic includes override hint", async () => {
    const wf = r.write(
      "t4.yaml",
      `name: test4
steps:
  deploy:
    type: tool
    tool_command: "deploy.sh"
    next: done
  done:
    type: exit
`,
    );
    const code = await validateCommand(wf);
    expect(code).toBe(0);
    expect(out()).toContain("timeout-minutes");
  });
});
