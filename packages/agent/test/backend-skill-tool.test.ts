// PiCodergenBackend — `skill` tool is force-included regardless of
// node `allowed_tools` / `denied_tools`.
//
// We don't peek into the pi-agent-core `Agent` constructor's `tools`
// list directly — instead we drive a real run against the faux
// provider, script the model to call `skill({ name: ... })`, and
// observe that the call resolves through the real skillTool (matching
// `cost.recorded` is unrelated; we look for a `tool.execution_end`
// event with `tool_name === "skill"`). If skill weren't wired, the
// faux provider's tool call would surface as an unknown-tool error
// from pi-agent-core, not a successful tool execution.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import type { EventType, NodeAttrs } from "@swarm/core";
import type { Skill } from "@swarm/types";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";

interface CapturedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

async function setupSkill(scratch: string): Promise<{ skill: Skill; skillsCatalog: Skill[] }> {
  const skillDir = join(scratch, "skills", "frontend");
  await mkdir(skillDir, { recursive: true });
  const md = `---\nname: frontend\ndescription: React patterns\n---\nuse react`;
  await writeFile(join(skillDir, "SKILL.md"), md, "utf8");
  const skill: Skill = {
    name: "frontend",
    description: "React patterns",
    location: join(skillDir, "SKILL.md"),
    skill_dir: skillDir,
    sha256: "a".repeat(64),
    bytes: md.length,
    scope: "project",
    source_dir: join(scratch, "skills"),
    // The per-run filter keeps project-scope records only when their
    // project_cwd matches `env.projectCwd()` — which is `scratch` for
    // a `LocalEnvironment({ cwd: scratch })`.
    project_cwd: scratch,
  };
  return { skill, skillsCatalog: [skill] };
}

function withSkillRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

async function runOnce(opts: {
  scratch: string;
  registry: ToolRegistry;
  skills: Skill[];
  attrs: NodeAttrs;
}): Promise<{ events: CapturedEvent[]; outcome: { status: string; failure_reason?: string } }> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    // Two-call script: call 1 emits a `skill` toolCall; call 2 stops
    // after seeing the toolResult so the agent loop terminates.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("skill", { name: "frontend" }, { id: "tc1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);

    const env = new LocalEnvironment({ cwd: opts.scratch });
    const backend = new PiCodergenBackend({
      registry: opts.registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      skills: opts.skills,
    });

    const events: CapturedEvent[] = [];
    const outcome = await backend.run({
      node: { id: "n1", shape: "box", attrs: opts.attrs, classes: [] },
      prompt: "load the frontend skill",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: "test-skill-wiring",
      workflow_sha: "sha",
      emit: async (type, data) => {
        events.push({ type, data });
      },
    });
    return { events, outcome };
  } finally {
    faux.unregister();
  }
}

describe("PiCodergenBackend skill tool wiring", () => {
  test("skill tool is present even when node.attrs.allowed_tools omits it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-skill-allow-"));
    try {
      const { skillsCatalog } = await setupSkill(scratch);
      const { events, outcome } = await runOnce({
        scratch,
        registry: withSkillRegistry(),
        skills: skillsCatalog,
        // allowed_tools deliberately excludes "skill" — the proposal says
        // the tool must still be reachable.
        attrs: { allowed_tools: ["read"] },
      });
      // The agent loop should terminate cleanly.
      expect(outcome.status).not.toBe("fail");
      // tool.execution_end with tool_name === "skill" proves the tool was
      // wired AND the call resolved (vs. unknown-tool error).
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "skill");
      expect(ends.length).toBe(1);
      const result = ends[0]!.data["result"] as { isError?: boolean; details?: { data?: { name?: string } } };
      expect(result.isError).toBeFalsy();
      expect(result.details?.data?.name).toBe("frontend");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("skill tool is present even when node.attrs.denied_tools lists it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-skill-deny-"));
    try {
      const { skillsCatalog } = await setupSkill(scratch);
      const { events, outcome } = await runOnce({
        scratch,
        registry: withSkillRegistry(),
        skills: skillsCatalog,
        // denied_tools tries to remove skill — the force-include must
        // still wire it.
        attrs: { denied_tools: ["skill"] },
      });
      expect(outcome.status).not.toBe("fail");
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "skill");
      expect(ends.length).toBe(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("skillCatalog is populated by the time the skill tool executes", async () => {
    // Pins the contract that the swarmContext.skillCatalog field is
    // visible from inside a tool-execute closure invoked during the
    // agent loop. If the patch were applied AFTER tool wiring AND the
    // closure captured by value (rather than by object reference), the
    // tool would see an empty catalogue and fail with unknown-name.
    const scratch = await mkdtemp(join(tmpdir(), "swarm-skill-catalog-"));
    try {
      const { skillsCatalog } = await setupSkill(scratch);
      const { events, outcome } = await runOnce({
        scratch,
        registry: withSkillRegistry(),
        skills: skillsCatalog,
        attrs: {}, // catch-all: skill is in the default tool set
      });
      expect(outcome.status).not.toBe("fail");
      const ends = events.filter((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "skill");
      expect(ends.length).toBe(1);
      const result = ends[0]!.data["result"] as {
        isError?: boolean;
        details?: { data?: { name?: string; path?: string } };
      };
      expect(result.isError).toBeFalsy();
      // The data.path proves the lookup found the catalog entry — an
      // empty catalog would have surfaced an unknown-name error here.
      expect(result.details?.data?.path).toContain("frontend/SKILL.md");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
