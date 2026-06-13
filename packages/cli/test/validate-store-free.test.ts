// `fragua validate` is store-free by contract: it never opens the
// SQLite store, so it works in CI / editor contexts with no DB present.
// Model ids resolve against the bundled offline pi-ai registry —
// near-miss typos of known ids error, unknown-but-plausible ids warn
// (the authoritative check is at enqueue).

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, getModels, getProviders, type KnownProvider, type Model } from "@earendil-works/pi-ai";
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

function allModels(): Model<Api>[] {
  return getProviders().flatMap((p) => getModels(p as KnownProvider) as Model<Api>[]);
}

function realPair(): { provider: string; id: string } {
  const m = allModels()[0];
  if (!m) throw new Error("bundled pi-ai registry is empty");
  return { provider: m.provider, id: m.id };
}

/** Separator typo of a real id — `-` swapped to `.` — that is not an
 * exact id anywhere in the bundled registry. */
function nearMissPair(): { provider: string; typo: string } {
  const ids = new Set(allModels().map((m) => m.id));
  for (const m of allModels()) {
    if (!m.id.includes("-")) continue;
    const typo = m.id.replace(/-/g, ".");
    if (!ids.has(typo)) return { provider: m.provider, typo };
  }
  throw new Error("no hyphenated model id in the bundled registry");
}

describe("fragua validate — store-free", () => {
  let r: Rig;
  let home: string;
  let prevHome: string | undefined;
  let logs: string[];

  beforeEach(() => {
    r = rig();
    home = mkdtempSync(join(tmpdir(), "fragua-home-"));
    prevHome = process.env["FRAGUA_HOME"];
    process.env["FRAGUA_HOME"] = home;
    logs = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env["FRAGUA_HOME"];
    else process.env["FRAGUA_HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    r.close();
  });

  const out = (): string => logs.join("\n");

  test("valid workflow with no store present → exit 0 and no fragua.db created", async () => {
    const { provider, id } = realPair();
    const wf = r.write(
      "t.yaml",
      `name: test
steps:
  plan:
    type: llm
    prompt: Do something
    model: "${id}"
    provider: "${provider}"
    next: done
  done:
    type: exit
`,
    );
    const code = await validateCommand(wf);
    expect(code).toBe(0);
    expect(existsSync(join(home, "fragua.db"))).toBe(false);
  });

  test("known-bad model (typo of built-in id) → exit 1 with [model] error", async () => {
    const { provider, typo } = nearMissPair();
    const wf = r.write(
      "t.yaml",
      `name: test
steps:
  plan:
    type: llm
    prompt: Do something
    model: "${typo}"
    provider: "${provider}"
    next: done
  done:
    type: exit
`,
    );
    const code = await validateCommand(wf);
    expect(code).toBe(1);
    expect(out()).toContain("[model] error");
    expect(out()).toContain("plan");
    expect(existsSync(join(home, "fragua.db"))).toBe(false);
  });

  test("unknown-but-plausible model → exit 0 with warning", async () => {
    const wf = r.write(
      "t.yaml",
      `name: test
steps:
  plan:
    type: llm
    prompt: Do something
    model: "custom-llm"
    provider: "mycorp"
    next: done
  done:
    type: exit
`,
    );
    const code = await validateCommand(wf);
    expect(code).toBe(0);
    expect(out()).toContain("[model] warning");
    expect(out()).toContain("enqueue");
    expect(existsSync(join(home, "fragua.db"))).toBe(false);
  });
});
