// Wave 3 — end-to-end check that `node.attrs.context_files` actually
// lands on the system prompt seen by the agent AND on the per-file
// records captured in `llm.start.context_files`. system-prompt.test.ts
// already pins the unit-level `loadContextFiles` behaviour; this suite
// runs the full PiCodergenBackend path so a future regression in the
// merge step (buildSystemPrompt → initialState.systemPrompt) can't slip
// through.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, InMemorySink, parseDotSource } from "@swarm/core";
import { LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { createPiMockBackend, fauxAssistantMessage, type PiMockBackendHandle } from "../src/mock.ts";

describe("context_files — end-to-end", () => {
  let scratch: string;
  let mock: PiMockBackendHandle;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-ctxf-"));
    mock = createPiMockBackend({ registry: new ToolRegistry(), env: new LocalEnvironment({ cwd: scratch }) });
  });

  afterEach(async () => {
    mock.dispose();
    await rm(scratch, { recursive: true, force: true });
  });

  test("file contents land byte-for-byte in the system prompt", async () => {
    const body = "# agents.md\n- rule one\n- rule two\n";
    await writeFile(join(scratch, "AGENTS.md"), body);
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    await execute({
      graph: parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          t [prompt="hi", fidelity="full", context_files="AGENTS.md"]
          done [shape=Msquare]
          s -> t -> done
        }
      `),
      sink,
      backend: mock.backend,
    });
    const start = sink.byType("llm.start")[0]!.data as {
      system_prompt: string;
      context_files: Array<{ path: string; sha256: string; bytes: number; status: string }>;
    };
    expect(start.system_prompt).toContain(`<project-conventions source="AGENTS.md">`);
    expect(start.system_prompt).toContain(body.trim());
    expect(start.context_files).toHaveLength(1);
    expect(start.context_files[0]).toMatchObject({
      path: "AGENTS.md",
      status: "ok",
      bytes: Buffer.byteLength(body, "utf8"),
    });
    expect(start.context_files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("multiple files concatenate in the order the author listed them", async () => {
    await writeFile(join(scratch, "first.md"), "first body\n");
    await writeFile(join(scratch, "second.md"), "second body\n");
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    await execute({
      graph: parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          t [prompt="hi", fidelity="full", context_files="first.md, second.md"]
          done [shape=Msquare]
          s -> t -> done
        }
      `),
      sink,
      backend: mock.backend,
    });
    const start = sink.byType("llm.start")[0]!.data as {
      system_prompt: string;
      context_files: Array<{ path: string }>;
    };
    expect(start.context_files.map((f) => f.path)).toEqual(["first.md", "second.md"]);
    const firstAt = start.system_prompt.indexOf("first body");
    const secondAt = start.system_prompt.indexOf("second body");
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(secondAt).toBeGreaterThan(firstAt);
  });

  test("missing file → status=missing, pipeline still runs, agent.warning emitted", async () => {
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    const res = await execute({
      graph: parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          t [prompt="hi", fidelity="full", context_files="NOPE.md"]
          done [shape=Msquare]
          s -> t -> done
        }
      `),
      sink,
      backend: mock.backend,
    });
    expect(res.outcome.status).toBe("success");
    const ctxFiles = (sink.byType("llm.start")[0]!.data as { context_files: Array<{ status: string }> }).context_files;
    expect(ctxFiles[0]!.status).toBe("missing");
    const warnings = sink.byType("agent.warning").map((e) => (e.data as { message?: string }).message ?? "");
    expect(warnings.some((w) => w.includes("NOPE.md"))).toBe(true);
  });

  test("oversized contents truncate the assembled block AND flag every loaded file", async () => {
    const giant = "x".repeat(40 * 1024);
    await writeFile(join(scratch, "big.md"), giant);
    mock.setResponses([fauxAssistantMessage("ok", { stopReason: "stop" })]);
    const sink = new InMemorySink();
    await execute({
      graph: parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          t [prompt="hi", fidelity="full", context_files="big.md"]
          done [shape=Msquare]
          s -> t -> done
        }
      `),
      sink,
      backend: mock.backend,
    });
    const start = sink.byType("llm.start")[0]!.data as {
      system_prompt: string;
      context_files: Array<{ truncated: boolean; bytes: number }>;
    };
    expect(start.system_prompt).toContain("[context_files: truncated");
    expect(start.context_files[0]!.truncated).toBe(true);
    // Byte count is pre-truncation — the full file size.
    expect(start.context_files[0]!.bytes).toBe(40 * 1024);
  });
});
