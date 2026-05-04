// Workflow-load model-ID validation — catches `claude-sonnet-4-6`
// (hyphen form on OpenRouter) and similar typos at registration,
// before we spend tokens on a plan phase only to halt at implement.

import { describe, expect, test } from "bun:test";
import { validateWorkflowModels } from "../src/workflow-model-validator.ts";

describe("validateWorkflowModels", () => {
  test("accepts a workflow with no model declarations (runtime default)", () => {
    const dot = `digraph {
      start [shape=Mdiamond];
      plan  [shape=box];
      done  [shape=Msquare];
      start -> plan;
      plan -> done;
    }`;
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(true);
  });

  test("accepts a codergen node with a correct (provider, model) pair", () => {
    // Anthropic direct uses hyphen IDs; OpenRouter uses dotted IDs.
    const dotAnthropic = `digraph {
      start [shape=Mdiamond];
      impl  [shape=box, llm_model="claude-sonnet-4-6", llm_provider="anthropic"];
      done  [shape=Msquare];
      start -> impl;
      impl -> done;
    }`;
    expect(validateWorkflowModels(dotAnthropic).ok).toBe(true);

    const dotOpenRouter = `digraph {
      start [shape=Mdiamond];
      impl  [shape=box, llm_model="anthropic/claude-sonnet-4.6", llm_provider="openrouter"];
      done  [shape=Msquare];
      start -> impl;
      impl -> done;
    }`;
    expect(validateWorkflowModels(dotOpenRouter).ok).toBe(true);
  });

  test("rejects a hyphen-form OpenRouter model id (the build-feature.dot bug)", () => {
    // Reproduces 01kppc3ekjk91fr3jd: `llm_provider="openrouter"` + hyphen
    // form resolves to a missing pi-ai entry. A workflow that declares
    // this should fail to register.
    const dot = `digraph {
      start [shape=Mdiamond];
      impl  [shape=box, llm_model="claude-sonnet-4-6", llm_provider="openrouter"];
      done  [shape=Msquare];
      start -> impl;
      impl -> done;
    }`;
    const r = validateWorkflowModels(dot);
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
    const dot = `digraph {
      start [shape=Mdiamond];
      impl  [shape=box, llm_model="claude-sonnet-4-6"];
      done  [shape=Msquare];
      start -> impl;
      impl -> done;
    }`;
    // anthropic resolves claude-sonnet-4-6 (hyphen form), so this model
    // without an explicit provider is accepted at registration. It will
    // still halt at runtime if the daemon's defaultModel.provider is
    // openrouter, but that's a narrower class of error than wholesale
    // typos.
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(true);
  });

  test("rejects a model that no known provider recognises", () => {
    const dot = `digraph {
      start [shape=Mdiamond];
      impl  [shape=box, llm_model="claude-zapp-brannigan-v9"];
      done  [shape=Msquare];
      start -> impl;
      impl -> done;
    }`;
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offenders).toHaveLength(1);
      expect(r.offenders[0]?.nodeId).toBe("impl");
      expect(r.offenders[0]?.provider).toBeUndefined();
      expect(r.offenders[0]?.reason).toMatch(/does not resolve under any known provider/);
    }
  });

  test("rejects multiple offenders per workflow", () => {
    const dot = `digraph {
      start  [shape=Mdiamond];
      impl   [shape=box, llm_model="claude-sonnet-4-6", llm_provider="openrouter"];
      verify [shape=box, llm_model="claude-zapp-brannigan-v9"];
      done   [shape=Msquare];
      start -> impl;
      impl -> verify;
      verify -> done;
    }`;
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.offenders).toHaveLength(2);
      const ids = r.offenders.map((o) => o.nodeId).sort();
      expect(ids).toEqual(["impl", "verify"]);
    }
  });

  test("skips non-codergen shapes (start/exit/tool/etc.) even when they carry model attrs", () => {
    // Real workflows don't put model attrs on non-box shapes; the DOT
    // parser scrubs them, and even if it didn't, we don't care — only
    // codergen nodes LLM-dispatch.
    const dot = `digraph {
      start [shape=Mdiamond, llm_model="claude-zapp-brannigan-v9", llm_provider="fake"];
      plan  [shape=box, llm_model="claude-sonnet-4-6", llm_provider="anthropic"];
      done  [shape=Msquare];
      start -> plan;
      plan -> done;
    }`;
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(true);
  });

  test("accepts when DOT cannot be parsed (lets the downstream parser surface the real error)", () => {
    const r = validateWorkflowModels("not a valid digraph");
    // Validator is lenient on parse errors by design — the parser
    // emits its own error later in the registration path.
    expect(r.ok).toBe(true);
  });

  test("rejects an unknown model declared via model_stylesheet (regression: 01kqs7aq2qha5ke3b2)", () => {
    // The failing run used merge.dot sha 6b06ea3 with:
    //   model_stylesheet = "* { llm_provider: anthropic; llm_model: claude-sonnet-4-6; }
    //                       #preflight { llm_model: claude-haiku-4-6; }"
    // No per-node attrs declared the bad model — it lived only in the
    // stylesheet, which the validator used to skip entirely.
    const dot = `digraph {
      graph [model_stylesheet="* { llm_provider: anthropic; llm_model: claude-sonnet-4-6; } #preflight { llm_model: claude-haiku-4-6; }"];
      start     [shape=Mdiamond];
      preflight [shape=box];
      done      [shape=Msquare];
      start -> preflight;
      preflight -> done;
    }`;
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const preflight = r.offenders.find((o) => o.nodeId === "preflight");
      expect(preflight).toBeDefined();
      expect(preflight?.provider).toBe("anthropic");
      expect(preflight?.model).toBe("claude-haiku-4-6");
    }
  });

  test("accepts a workflow whose stylesheet resolves to known (provider, model) pairs", () => {
    const dot = `digraph {
      graph [model_stylesheet="* { llm_provider: anthropic; llm_model: claude-sonnet-4-6; } #preflight { llm_model: claude-haiku-4-5; }"];
      start     [shape=Mdiamond];
      preflight [shape=box];
      review    [shape=box];
      done      [shape=Msquare];
      start -> preflight;
      preflight -> review;
      review -> done;
    }`;
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(true);
  });

  test("per-node llm_model overrides stylesheet (per-node wins per §8.5)", () => {
    // Stylesheet declares a bad model; the per-node attr overrides it
    // with a known-good one. Validator must defer to the per-node attr,
    // matching dispatcher behaviour.
    const dot = `digraph {
      graph [model_stylesheet="* { llm_provider: anthropic; llm_model: claude-zapp-brannigan-v9; }"];
      start [shape=Mdiamond];
      impl  [shape=box, llm_model="claude-sonnet-4-6"];
      done  [shape=Msquare];
      start -> impl;
      impl -> done;
    }`;
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(true);
  });

  test("stylesheet bare model (no provider) goes through the lenient bare-id path", () => {
    const dot = `digraph {
      graph [model_stylesheet="* { llm_model: claude-sonnet-4-6; }"];
      start [shape=Mdiamond];
      impl  [shape=box];
      done  [shape=Msquare];
      start -> impl;
      impl -> done;
    }`;
    // anthropic resolves the bare hyphen form; lenient path accepts.
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(true);
  });

  test("accepts the fixed build-feature.dot", () => {
    // Spot-check: after B in the plan, build-feature.dot uses
    // `llm_model="anthropic/claude-sonnet-4.6"` without a provider attr.
    // OpenRouter recognises the dotted id; anthropic/direct does not
    // (it wants the hyphen form). Lenient path accepts.
    const dot = `digraph {
      start  [shape=Mdiamond];
      plan   [shape=box];
      impl   [shape=box, llm_model="anthropic/claude-sonnet-4.6"];
      done   [shape=Msquare];
      start -> plan;
      plan -> impl;
      impl -> done;
    }`;
    const r = validateWorkflowModels(dot);
    expect(r.ok).toBe(true);
  });
});
