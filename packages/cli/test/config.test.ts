// Tests for .swarm/config.yaml loading. Config is always optional; missing or
// malformed files return `{}` rather than throwing so first-run UX is smooth.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-config-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  test("returns {} when .swarm/config.yaml is missing", async () => {
    const cfg = await loadConfig(scratch);
    expect(cfg).toEqual({});
  });

  test("parses defaults.provider and defaults.model", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(
      join(scratch, ".swarm/config.yaml"),
      `defaults:\n  provider: openrouter\n  model: anthropic/claude-opus-4.7\n`,
      "utf8",
    );
    const cfg = await loadConfig(scratch);
    expect(cfg.defaults?.provider).toBe("openrouter");
    expect(cfg.defaults?.model).toBe("anthropic/claude-opus-4.7");
  });

  test("parses project.runs_dir", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), `project:\n  name: demo\n  runs_dir: custom/runs\n`, "utf8");
    const cfg = await loadConfig(scratch);
    expect(cfg.project?.name).toBe("demo");
    expect(cfg.project?.runs_dir).toBe("custom/runs");
  });

  test("returns {} on malformed YAML (never throws)", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), ": : not yaml : :", "utf8");
    const cfg = await loadConfig(scratch);
    expect(cfg).toEqual({});
  });

  test("returns {} when file parses to a non-object (e.g. just a string)", async () => {
    await mkdir(join(scratch, ".swarm"), { recursive: true });
    await writeFile(join(scratch, ".swarm/config.yaml"), "just-a-string", "utf8");
    const cfg = await loadConfig(scratch);
    expect(cfg).toEqual({});
  });
});
