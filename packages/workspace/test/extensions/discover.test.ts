// Discovery-phase tests for the extensions loader.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { discoverExtensions } from "../../src/extensions/index.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await fsTmpDir("swarm-ext-discover");
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function fsTmpDir(prefix: string): Promise<string> {
  const dir = resolve(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeExtension(root: string, name: string, contents = "export default () => {};"): Promise<void> {
  const dir = resolve(root, ".swarm/extensions");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, name), contents);
}

describe("discoverExtensions", () => {
  test("returns empty when no extension dirs exist", async () => {
    const { discovered, warnings } = await discoverExtensions({ cwd: tmp });
    expect(discovered).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("finds flat *.ts extensions in project scope", async () => {
    await writeExtension(tmp, "hello.ts");
    await writeExtension(tmp, "world.ts");
    const { discovered } = await discoverExtensions({ cwd: tmp });
    expect(discovered.map((e) => e.basename).sort()).toEqual(["hello", "world"]);
    expect(discovered.every((e) => e.scope === "project")).toBe(true);
    expect(discovered.every((e) => e.extensionId.startsWith("project:"))).toBe(true);
  });

  test("excludes paired *.web.tsx and *.tui.ts files from daemon glob", async () => {
    await writeExtension(tmp, "weather.ts");
    await writeExtension(tmp, "weather.web.tsx", "export default {};");
    await writeExtension(tmp, "weather.tui.ts", "export default {};");
    const { discovered } = await discoverExtensions({ cwd: tmp });
    expect(discovered.map((e) => e.sourcePath)).toHaveLength(1);
    expect(discovered[0]!.sourcePath.endsWith("weather.ts")).toBe(true);
  });

  test("excludes test files and *.d.ts", async () => {
    await writeExtension(tmp, "tool.ts");
    await writeExtension(tmp, "tool.test.ts");
    await writeExtension(tmp, "tool.spec.ts");
    await writeExtension(tmp, "tool.d.ts");
    const { discovered } = await discoverExtensions({ cwd: tmp });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.basename).toBe("tool");
  });

  test("rejects basenames that don't match /^[a-z][a-z0-9_]*$/", async () => {
    await writeExtension(tmp, "Bad-Name.ts");
    await writeExtension(tmp, "ok_name.ts");
    const { discovered, warnings } = await discoverExtensions({ cwd: tmp });
    expect(discovered.map((e) => e.basename)).toEqual(["ok_name"]);
    expect(warnings.some((w) => w.includes("Bad-Name"))).toBe(true);
  });

  test("finds directory extensions with index.ts", async () => {
    const dir = resolve(tmp, ".swarm/extensions/myext");
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, "index.ts"), "export default () => {};");
    const { discovered } = await discoverExtensions({ cwd: tmp });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.basename).toBe("myext");
    expect(discovered[0]!.sourcePath.endsWith("/myext/index.ts")).toBe(true);
  });

  test("project beats user on basename collision", async () => {
    const home = await fsTmpDir("swarm-ext-home");
    await writeExtension(home, "foo.ts", "// user");
    await writeExtension(tmp, "foo.ts", "// project");
    const { discovered, warnings } = await discoverExtensions({ cwd: tmp, homeDir: home });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.scope).toBe("project");
    expect(warnings.some((w) => w.includes("shadowed"))).toBe(true);
    await rm(home, { recursive: true, force: true });
  });

  test("trustProject=false marks project extensions disabled", async () => {
    await writeExtension(tmp, "audit.ts");
    const { discovered } = await discoverExtensions({
      cwd: tmp,
      config: { trustProject: false },
    });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]!.disabled_reason).toContain("trustProject=false");
  });

  test("disabled list hard-skips by basename across scopes", async () => {
    const home = await fsTmpDir("swarm-ext-home");
    await writeExtension(home, "audit.ts");
    await writeExtension(tmp, "policy.ts");
    const { discovered } = await discoverExtensions({
      cwd: tmp,
      homeDir: home,
      config: { disabled: ["audit", "policy"] },
    });
    expect(discovered).toHaveLength(2);
    for (const ext of discovered) {
      expect(ext.disabled_reason).toContain("disabled by config");
    }
    await rm(home, { recursive: true, force: true });
  });
});
