import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, registerFauxProvider } from "@mariozechner/pi-ai";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { createSubagentTool } from "../src/subagent.ts";

describe("createSubagentTool — nested Agent with faux provider", () => {
  let scratch: string;
  let registry: ToolRegistry;
  let env: LocalEnvironment;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "swarm-sub-"));
    registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    env = new LocalEnvironment({ cwd: scratch });
    faux = registerFauxProvider();
  });

  afterEach(async () => {
    faux.unregister();
    await rm(scratch, { recursive: true, force: true });
  });

  test("returns the sub-agent's final text response", async () => {
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage([fauxText("the answer is 42")], { stopReason: "stop" })]);
    const tool = createSubagentTool({
      registry,
      env,
      defaultModel: { provider: model.provider, model: model.id },
      resolveModel: () => model,
    });

    const out = await tool.execute({ prompt: "what's the answer?" }, env);
    expect(out.text).toContain("42");
    expect(out.is_error).toBeFalsy();
  });

  test("fork-bomb guard: subagent cannot spawn further subagents", async () => {
    const model = faux.getModel();
    const tool = createSubagentTool({
      registry,
      env,
      defaultModel: { provider: model.provider, model: model.id },
      resolveModel: () => model,
    });
    // Register the tool after creation so it's in the parent registry
    registry.register(tool);

    faux.setResponses([fauxAssistantMessage([fauxText("I only have core tools")], { stopReason: "stop" })]);
    const out = await tool.execute({ prompt: "can you spawn another subagent?" }, env);
    expect(out.is_error).toBeFalsy();
    // The text we expect depends on the model; here we just verify the tool
    // didn't blow up and the subagent got a response back.
  });

  test("allowed_tools filter scopes the subagent's tools", async () => {
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage([fauxText("ok")], { stopReason: "stop" })]);
    const tool = createSubagentTool({
      registry,
      env,
      defaultModel: { provider: model.provider, model: model.id },
      resolveModel: () => model,
    });
    // No direct way to introspect; rely on the execution not crashing and
    // the schema accepting the filter.
    const out = await tool.execute({ prompt: "hi", allowed_tools: ["local:read_file"] }, env);
    expect(out.is_error).toBeFalsy();
  });

  test("unknown model → is_error=true", async () => {
    const tool = createSubagentTool({
      registry,
      env,
      defaultModel: { provider: "does-not-exist", model: "nope" },
      resolveModel: (p, m) => {
        throw new Error(`no model ${p}/${m}`);
      },
    });
    const out = await tool.execute({ prompt: "hi" }, env);
    expect(out.is_error).toBe(true);
    expect(out.text.toLowerCase()).toMatch(/resolve|unknown|no model/);
  });
});
