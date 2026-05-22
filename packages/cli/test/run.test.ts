// fragua run: full round-trip — CLI uploads the workflow, enqueues a run, streams
// events until terminal. Spins up a real server + a foreground daemon
// fiber so the SSE stream actually progresses.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as handler from "@fragua/core/handler";
import { AbortRegistry, autoDispatcherResolver, Dispatcher, runExecutor } from "@fragua/daemon";
import { createServer } from "@fragua/server";
import { SqliteStore } from "@fragua/store";
import { resolveInputArgs, runCommand } from "../src/commands/run.ts";

interface Rig {
  url: string;
  store: SqliteStore;
  close: () => Promise<void>;
}

const tmps: string[] = [];

afterEach(() => {
  while (tmps.length > 0) {
    const d = tmps.pop();
    try {
      if (d != null) rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "fragua-run-"));
  tmps.push(dir);
  mkdirSync(join(dir, ".fragua"), { recursive: true });
  const store = new SqliteStore({ path: join(dir, ".fragua/fragua.db") });

  const dispatcher = new Dispatcher();
  dispatcher.setResolver(autoDispatcherResolver({ store }));
  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });

  const app = createServer({ store });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });
  const url = `http://127.0.0.1:${server.port}`;

  const shutdown = new AbortController();
  const executorPromise = runExecutor({
    store,
    dispatcher,
    registry: new AbortRegistry(),
    tools,
    llmCall,
    maxConcurrentRuns: 2,
    pollIntervalMs: 10,
    shutdownSignal: shutdown.signal,
  }).catch(() => {});

  return {
    url,
    store,
    close: async () => {
      shutdown.abort();
      await executorPromise;
      await server.stop(true);
      store.close();
    },
  };
}

describe("fragua run", () => {
  test("round-trip: YAML file → upload → enqueue → stream → completed", async () => {
    const r = await rig();
    try {
      const workflowDir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
      tmps.push(workflowDir);
      const yamlPath = join(workflowDir, "echo.yaml");
      writeFileSync(yamlPath, `name: echo\nsteps:\n  work: {type: llm, prompt: hi}\n`);

      const exitCode = await runCommand({
        workflow: yamlPath,
        url: r.url,
      });
      expect(exitCode).toBe(0);
    } finally {
      await r.close();
    }
  });

  test("cannot read workflow file → exit 1", async () => {
    const code = await runCommand({
      workflow: "/nonexistent/workflow.yaml",
      url: "http://127.0.0.1:1",
    });
    expect(code).toBe(1);
  });

  test("unreachable server → exit 1 with actionable guidance, not a raw ConnectionRefused", async () => {
    const workflowDir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
    tmps.push(workflowDir);
    const yamlPath = join(workflowDir, "echo.yaml");
    writeFileSync(yamlPath, `name: echo\nsteps:\n  work: {type: llm, prompt: hi}\n`);

    const errs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(" "));
    };
    try {
      // Port 1 has no listener: postJson rejects with ConnectionRefused.
      // The command must catch it and return 1 rather than throwing.
      const code = await runCommand({ workflow: yamlPath, url: "http://127.0.0.1:1" });
      expect(code).toBe(1);
    } finally {
      console.error = originalError;
    }
    const joined = errs.join("\n");
    expect(joined).toContain("could not reach a fragua server");
    expect(joined).toContain("fragua harness");
  });

  test("--no-follow exits immediately after enqueue", async () => {
    const r = await rig();
    try {
      const workflowDir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
      tmps.push(workflowDir);
      const yamlPath = join(workflowDir, "echo.yaml");
      writeFileSync(yamlPath, `name: echo\nsteps:\n  work: {type: llm, prompt: hi}\n`);

      const code = await runCommand({
        workflow: yamlPath,
        url: r.url,
        follow: false,
      });
      expect(code).toBe(0);
    } finally {
      await r.close();
    }
  });

  test("--title is sent on the enqueue body; the free-form input is no longer sent", async () => {
    const r = await rig();
    const originalFetch = globalThis.fetch;
    let runsBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.endsWith("/runs") && init?.method === "POST" && typeof init.body === "string") {
        runsBody = JSON.parse(init.body) as Record<string, unknown>;
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const workflowDir = mkdtempSync(join(tmpdir(), "fragua-wf-"));
      tmps.push(workflowDir);
      const yamlPath = join(workflowDir, "echo.yaml");
      writeFileSync(yamlPath, `name: echo\nsteps:\n  work: {type: llm, prompt: hi}\n`);

      const code = await runCommand({
        workflow: yamlPath,
        url: r.url,
        follow: false,
        title: "Rename foo to bar",
      });
      expect(code).toBe(0);
      expect(runsBody).toBeDefined();
      expect(runsBody!["title"]).toBe("Rename foo to bar");
      expect("input" in runsBody!).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      await r.close();
    }
  });
});

describe("resolveInputArgs", () => {
  test("parses repeated name=value pairs; value may contain '='", async () => {
    const out = await resolveInputArgs(["env=prod", "url=a=b"]);
    expect(out).toEqual({ env: "prod", url: "a=b" });
  });

  test("a single flag arrives as a string, not an array", async () => {
    expect(await resolveInputArgs("ticket=BUG-1")).toEqual({ ticket: "BUG-1" });
  });

  test("undefined → empty map", async () => {
    expect(await resolveInputArgs(undefined)).toEqual({});
  });

  test("@path sources the value verbatim from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fragua-input-"));
    tmps.push(dir);
    const specPath = join(dir, "spec.md");
    writeFileSync(specPath, "add a touch tool\nwith two lines\n");
    const out = await resolveInputArgs([`task=@${specPath}`]);
    expect(out["task"]).toBe("add a touch tool\nwith two lines\n");
  });

  test("malformed entry (no '=' / empty name) throws", async () => {
    await expect(resolveInputArgs(["nokey"])).rejects.toThrow(/name=value/);
    await expect(resolveInputArgs(["=value"])).rejects.toThrow(/name=value/);
  });
});
