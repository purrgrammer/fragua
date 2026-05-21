// Bare-name resolution: global wins, project is the fallback. Path
// arguments resolve directly. Misses surface as null so the CLI can
// render a precise error.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveWorkflow } from "../src/workflow-path.ts";

describe("resolveWorkflow", () => {
  let cwd: string;
  let home: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "fragua-cwd-"));
    home = await mkdtemp(join(tmpdir(), "fragua-home-"));
    await mkdir(join(cwd, ".fragua/workflows"), { recursive: true });
    await mkdir(join(home, ".fragua/workflows"), { recursive: true });
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  test("bare name in global wins", async () => {
    await writeFile(
      join(home, ".fragua/workflows/foo.yaml"),
      "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
      "utf8",
    );
    const r = await resolveWorkflow(cwd, "foo", { homeDir: home });
    expect(r).toEqual({
      dotPath: resolve(home, ".fragua/workflows/foo.yaml"),
      name: "foo",
      scope: "global",
    });
  });

  test("bare name falls back to project when global misses", async () => {
    await writeFile(
      join(cwd, ".fragua/workflows/foo.yaml"),
      "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
      "utf8",
    );
    const r = await resolveWorkflow(cwd, "foo", { homeDir: home });
    expect(r).toEqual({
      dotPath: resolve(cwd, ".fragua/workflows/foo.yaml"),
      name: "foo",
      scope: "local",
    });
  });

  test("global wins over local when both exist", async () => {
    await writeFile(
      join(home, ".fragua/workflows/foo.yaml"),
      "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
      "utf8",
    );
    await writeFile(
      join(cwd, ".fragua/workflows/foo.yaml"),
      "name: t\nsteps:\n  work: {type: llm, prompt: x}\n",
      "utf8",
    );
    const r = await resolveWorkflow(cwd, "foo", { homeDir: home });
    expect(r?.scope).toBe("global");
    expect(r?.dotPath).toBe(resolve(home, ".fragua/workflows/foo.yaml"));
  });

  test("explicit relative path resolves against cwd", async () => {
    await writeFile(join(cwd, "scratch.yaml"), "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", "utf8");
    const r = await resolveWorkflow(cwd, "./scratch.yaml", { homeDir: home });
    expect(r).toEqual({
      dotPath: resolve(cwd, "scratch.yaml"),
      name: "scratch",
      scope: "path",
    });
  });

  test("explicit absolute path resolves directly", async () => {
    const abs = resolve(cwd, "abs.yaml");
    await writeFile(abs, "name: t\nsteps:\n  work: {type: llm, prompt: x}\n", "utf8");
    const r = await resolveWorkflow(cwd, abs, { homeDir: home });
    expect(r?.scope).toBe("path");
    expect(r?.dotPath).toBe(abs);
  });

  test("missing bare name → null", async () => {
    expect(await resolveWorkflow(cwd, "ghost", { homeDir: home })).toBeNull();
  });

  test("missing path → null", async () => {
    expect(await resolveWorkflow(cwd, "./missing.yaml", { homeDir: home })).toBeNull();
  });
});
