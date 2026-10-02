// E055 / E056: a judge step's `provider:` and the default model that follows
// from it. Membership of a MODEL in a provider is deliberately not checked —
// a local runtime's list changes under `pull`.

import { describe, expect, test } from "bun:test";
import { JUDGE_BUILTIN_PROVIDERS } from "@fragua/core/handler";
import { validateWorkflowJudgeProviders, validateWorkflowJudgeProvidersOffline } from "../src/index.ts";

const WF = (attrs: string) => `
name: wf
steps:
  j:
    type: judge
${attrs}    state: hello
    questions:
      ok: {type: noul, instructions: ok?}
    next: exit
`;

describe("judge provider validation", () => {
  test("a configured provider with a default model is clean", () => {
    expect(validateWorkflowJudgeProviders(WF(""), JUDGE_BUILTIN_PROVIDERS, "typesafe")).toEqual([]);
  });

  test("E055 — an unconfigured provider, naming the ones that exist", () => {
    const diags = validateWorkflowJudgeProviders(WF("    provider: nope\n"), JUDGE_BUILTIN_PROVIDERS, "typesafe");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ nodeId: "j", code: "E055", severity: "error" });
    expect(diags[0]!.message).toMatch(/known: ollaya, typesafe/);
  });

  test("E056 — a provider with no default model and no `model:` on the step", () => {
    const diags = validateWorkflowJudgeProviders(WF("    provider: ollaya\n"), JUDGE_BUILTIN_PROVIDERS, "typesafe");
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ nodeId: "j", code: "E056", severity: "error" });
  });

  test("naming `model:` satisfies E056", () => {
    const wf = WF("    provider: ollaya\n    model: laya\n");
    expect(validateWorkflowJudgeProviders(wf, JUDGE_BUILTIN_PROVIDERS, "typesafe")).toEqual([]);
  });

  test("the default provider is what a step naming none is checked against", () => {
    // Selecting ollaya globally makes every model-less judge step an E056.
    const diags = validateWorkflowJudgeProviders(WF(""), JUDGE_BUILTIN_PROVIDERS, "ollaya");
    expect(diags[0]).toMatchObject({ code: "E056" });
  });

  test("a step's `model:` is never checked for membership", () => {
    const wf = WF("    provider: ollaya\n    model: not-a-real-model\n");
    expect(validateWorkflowJudgeProviders(wf, JUDGE_BUILTIN_PROVIDERS, "typesafe")).toEqual([]);
  });

  test("offline: an unknown provider warns, because a judge: row may define it", () => {
    const diags = validateWorkflowJudgeProvidersOffline(WF("    provider: lab\n    model: kev\n"));
    expect(diags[0]).toMatchObject({ code: "E055", severity: "warning" });
  });

  test("offline: a bare judge step resolves against the configured default provider", () => {
    const bare = WF("");
    expect(validateWorkflowJudgeProvidersOffline(bare)).toEqual([]);
    const diags = validateWorkflowJudgeProvidersOffline(bare, "ollaya");
    expect(diags[0]).toMatchObject({ code: "E056", severity: "error" });
  });

  test("offline: a known provider with no default model still errors", () => {
    const diags = validateWorkflowJudgeProvidersOffline(WF("    provider: ollaya\n"));
    expect(diags[0]).toMatchObject({ code: "E056", severity: "error" });
  });

  test("a workflow with no judge steps yields nothing", () => {
    const wf = `
name: wf
steps:
  a:
    prompt: hi
    next: exit
`;
    expect(validateWorkflowJudgeProvidersOffline(wf)).toEqual([]);
  });
});
