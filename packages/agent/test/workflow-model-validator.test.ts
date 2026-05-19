// Workflow-load model-ID validation — catches `claude-sonnet-4-6`
// (hyphen form on OpenRouter) and similar typos at registration,
// before we spend tokens on a plan phase only to halt at implement.

import { describe, expect, test } from "bun:test";
import { validateWorkflowModels } from "../src/workflow-model-validator.ts";

describe("validateWorkflowModels", () => {
  test("accepts a workflow with no model declarations (runtime default)", () => {
    const yaml = `name: t\nsteps:\n  plan: {type: llm, prompt: p}\n`;
    expect(validateWorkflowModels(yaml).ok).toBe(true);
  });

  test("accepts a llm step with a correct (provider, model) pair", () => {
    const yamlAnthropic = `name: t
steps:
  impl: {type: llm, prompt: x, model: "claude-sonnet-4-6", provider: "anthropic"}
`;
    expect(validateWorkflowModels(yamlAnthropic).ok).toBe(true);

    const yamlOpenRouter = `name: t
steps:
  impl: {type: llm, prompt: x, model: "anthropic/claude-sonnet-4.6", provider: "openrouter"}
`;
    expect(validateWorkflowModels(yamlOpenRouter).ok).toBe(true);
  });

  test("rejects a hyphen-form OpenRouter model id", () => {
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "claude-sonnet-4-6", provider: "openrouter"}
`;
    const r = validateWorkflowModels(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offenders).toHaveLength(1);
      expect(r.offenders[0]?.nodeId).toBe("impl");
      expect(r.offenders[0]?.provider).toBe("openrouter");
      expect(r.offenders[0]?.model).toBe("claude-sonnet-4-6");
      expect(r.offenders[0]?.reason).toMatch(/openrouter\/claude-sonnet-4-6/);
    }
  });

  test("lenient: model without provider accepted when any known provider resolves it", () => {
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "claude-sonnet-4-6"}
`;
    expect(validateWorkflowModels(yaml).ok).toBe(true);
  });

  test("rejects a model that no known provider recognises", () => {
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "claude-zapp-brannigan-v9"}
`;
    const r = validateWorkflowModels(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offenders).toHaveLength(1);
      expect(r.offenders[0]?.nodeId).toBe("impl");
      expect(r.offenders[0]?.provider).toBeUndefined();
      expect(r.offenders[0]?.reason).toMatch(/does not resolve under any known provider/);
    }
  });

  test("rejects multiple offenders per workflow", () => {
    const yaml = `name: t
steps:
  impl:   {type: llm, prompt: x, model: "claude-sonnet-4-6", provider: "openrouter", next: verify}
  verify: {type: llm, prompt: v, model: "claude-zapp-brannigan-v9"}
`;
    const r = validateWorkflowModels(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offenders).toHaveLength(2);
      const ids = r.offenders.map((o) => o.nodeId).sort();
      expect(ids).toEqual(["impl", "verify"]);
    }
  });

  test("accepts when source cannot be parsed (lets the downstream parser surface the real error)", () => {
    const r = validateWorkflowModels("not a valid workflow");
    expect(r.ok).toBe(true);
  });

  test("accepts the canonical build-feature workflow", () => {
    const yaml = `name: t
steps:
  plan:   {type: llm, prompt: p, next: impl}
  impl:   {type: llm, prompt: i, model: "anthropic/claude-sonnet-4.6"}
`;
    expect(validateWorkflowModels(yaml).ok).toBe(true);
  });
});
