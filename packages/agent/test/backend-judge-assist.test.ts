// PiLlmBackend — the config-gated System One uses: a skill suggestion line
// at the end of the system prompt, and a guard in front of side-effecting
// tools. Both inert without a judge client; both emit their spend inside the
// step's cost window (after `llm.start`).

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import type { EventType } from "@fragua/core";
import type { JudgeAnswer, JudgeClient, JudgeRequest } from "@fragua/core/handler";
import type { Skill } from "@fragua/types";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@fragua/workspace";
import { PiLlmBackend } from "../src/backend.ts";
import type { JudgeAssistConfig } from "../src/judge-assist.ts";

interface CapturedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

const skill = (name: string, description: string): Skill => ({
  name,
  description,
  location: `/s/${name}/SKILL.md`,
  skill_dir: `/s/${name}`,
  source_dir: "/s",
  sha256: "0".repeat(64),
  bytes: 1,
  scope: "user",
});
const SKILLS: Skill[] = [
  skill("frontend", "React patterns for packages/web."),
  skill("backend", "SQL and store patterns."),
];

/** Answers by question shape: the suggestion call gets `frontend`, the guard
 * call gets the nouls `answer` returns. */
function stubJudge(requests: JudgeRequest[], guard: (req: JudgeRequest) => Record<string, JudgeAnswer>): JudgeClient {
  return {
    provider: "typesafe",
    async ask(req) {
      requests.push(req);
      const answers: Record<string, JudgeAnswer> =
        "skill" in req.questions
          ? {
              skill: {
                type: "choice",
                choice: "frontend",
                confidence: 0.9,
                probabilities: { frontend: 0.9, backend: 0.08, none: 0.02 },
              },
              needs_skill: { type: "noul", noul: 0.85 },
            }
          : guard(req);
      return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 5 }, costUsd: 0.0000042 };
    },
  };
}

const CALM = (): Record<string, JudgeAnswer> => ({
  destructive: { type: "noul", noul: 0.02 },
  off_task: { type: "noul", noul: 0.05 },
  exfiltrates: { type: "noul", noul: 0.01 },
});
const ALARMED = (): Record<string, JudgeAnswer> => ({
  destructive: { type: "noul", noul: 0.91 },
  off_task: { type: "noul", noul: 0.2 },
  exfiltrates: { type: "noul", noul: 0.03 },
});

async function runOnce(
  scratch: string,
  judge: JudgeClient | undefined,
  judgeAssist: JudgeAssistConfig,
): Promise<{ events: CapturedEvent[]; persisted: AgentMessage[] }> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("write", { path: "note.txt", content: "hi" }, { id: "tc1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
    ]);
    const registry = new ToolRegistry();
    registry.registerAll(CORE_TOOLS);
    const env = new LocalEnvironment({ cwd: scratch });
    const backend = new PiLlmBackend({
      registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      skills: SKILLS,
      judgeAssist,
    });
    const events: CapturedEvent[] = [];
    const persisted: AgentMessage[] = [];
    await backend.run({
      node: { id: "n1", type: "llm", attrs: {} },
      prompt: "Write a note file.",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: "test-judge-assist",
      workflow_sha: "sha",
      emit: async (type, data) => {
        events.push({ type, data });
      },
      persistMessage: (m) => {
        persisted.push(m);
      },
      ...(judge !== undefined ? { judge } : {}),
    });
    return { events, persisted };
  } finally {
    faux.unregister();
  }
}

function systemText(persisted: AgentMessage[]): string {
  const sys = persisted.find((m) => (m as { role: string }).role === "system") as { content?: string } | undefined;
  return sys?.content ?? "";
}

describe("PiLlmBackend — skill suggestion", () => {
  test("the winner lands as one line at the end of the system prompt; cost and verdict follow llm.start", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-judge-assist-"));
    try {
      const requests: JudgeRequest[] = [];
      const { events, persisted } = await runOnce(scratch, stubJudge(requests, CALM), {
        skillSuggestion: true,
        toolGuard: "off",
      });
      const suggestion = requests.find((r) => "skill" in r.questions);
      expect(suggestion).toBeDefined();
      expect((suggestion!.questions["skill"] as { criteria: Record<string, string> }).criteria).toHaveProperty("none");
      expect(
        systemText(persisted).trimEnd().endsWith("Ignore this if it does not fit what the step actually asks for."),
      ).toBe(true);
      expect(systemText(persisted)).toContain("Relevant to this step: frontend.");
      const startIdx = events.findIndex((e) => e.type === "llm.start");
      const costIdx = events.findIndex((e) => e.type === "cost.recorded" && e.data["kind"] === "judge");
      const infoIdx = events.findIndex((e) => e.type === "agent.info" && e.data["kind"] === "skill_suggestion");
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(costIdx).toBeGreaterThan(startIdx);
      expect(infoIdx).toBeGreaterThan(startIdx);
      expect(events[infoIdx]!.data["skill"]).toBe("frontend");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("off by default, and inert without a judge client", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-judge-assist-"));
    try {
      const requests: JudgeRequest[] = [];
      const off = await runOnce(scratch, stubJudge(requests, CALM), { skillSuggestion: false, toolGuard: "off" });
      expect(requests).toHaveLength(0);
      expect(systemText(off.persisted)).not.toContain("Relevant to this step");
      const noJudge = await runOnce(scratch, undefined, { skillSuggestion: true, toolGuard: "block" });
      expect(systemText(noJudge.persisted)).not.toContain("Relevant to this step");
      expect(noJudge.events.some((e) => e.type === "cost.recorded" && e.data["kind"] === "judge")).toBe(false);
      expect(await readFile(join(scratch, "note.txt"), "utf8")).toBe("hi");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

describe("PiLlmBackend — tool guard", () => {
  test("a calm verdict lets the call through and only records the judge cost", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-judge-assist-"));
    try {
      const requests: JudgeRequest[] = [];
      const { events } = await runOnce(scratch, stubJudge(requests, CALM), {
        skillSuggestion: false,
        toolGuard: "flag",
      });
      const guard = requests.find((r) => "destructive" in r.questions);
      expect(guard).toBeDefined();
      expect((guard!.state as { call: { tool: string } }).call.tool).toBe("write");
      expect(await readFile(join(scratch, "note.txt"), "utf8")).toBe("hi");
      expect(events.some((e) => e.type === "agent.warning" && e.data["kind"] === "tool_guard")).toBe(false);
      expect(events.filter((e) => e.type === "cost.recorded" && e.data["kind"] === "judge")).toHaveLength(1);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("flag: the call runs, the result carries the flag, a warning names it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-judge-assist-"));
    try {
      const { events } = await runOnce(scratch, stubJudge([], ALARMED), { skillSuggestion: false, toolGuard: "flag" });
      expect(await readFile(join(scratch, "note.txt"), "utf8")).toBe("hi");
      const warning = events.find((e) => e.type === "agent.warning" && e.data["kind"] === "tool_guard");
      expect(warning?.data["message"]).toContain("flagged write: destructive 0.91");
      const end = events.find((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "write");
      const result = end?.data["result"] as { content: Array<{ type: string; text?: string }> };
      expect(result.content.some((b) => b.text?.includes("tool guard flagged this call: destructive 0.91"))).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("block: the call never runs and the model reads a tool error", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "fragua-judge-assist-"));
    try {
      const { events } = await runOnce(scratch, stubJudge([], ALARMED), { skillSuggestion: false, toolGuard: "block" });
      await expect(readFile(join(scratch, "note.txt"), "utf8")).rejects.toThrow();
      const end = events.find((e) => e.type === "tool.execution_end" && e.data["tool_name"] === "write");
      expect(end?.data["is_error"]).toBe(true);
      const result = end?.data["result"] as { content: Array<{ type: string; text?: string }> };
      expect(result.content.some((b) => b.text?.includes("blocked by the tool guard (destructive 0.91)"))).toBe(true);
      const warning = events.find((e) => e.type === "agent.warning" && e.data["kind"] === "tool_guard");
      expect(warning?.data["mode"]).toBe("block");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
