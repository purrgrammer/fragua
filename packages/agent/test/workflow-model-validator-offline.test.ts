// Offline (store-free) model validation — `fragua validate`'s check
// against the bundled pi-ai registry. Exact matches pass, near-miss
// separator typos error, anything plausibly custom warns (the
// authoritative gate is at enqueue).

import { describe, expect, test } from "bun:test";
import { type Api, getModels, getProviders, type KnownProvider, type Model } from "@earendil-works/pi-ai";
import { validateWorkflowModelsOffline } from "../src/workflow-model-validator.ts";

function allModels(): Model<Api>[] {
  return getProviders().flatMap((p) => getModels(p as KnownProvider) as Model<Api>[]);
}

/** A real (provider, id) pair from the bundled registry. */
function realPair(): { provider: string; id: string } {
  const m = allModels()[0];
  if (!m) throw new Error("bundled pi-ai registry is empty");
  return { provider: m.provider, id: m.id };
}

/** A separator typo of a real id: every `-` swapped to `.`, guaranteed
 * not to be an exact id anywhere in the registry. */
function nearMissPair(): { provider: string; id: string; typo: string } {
  const ids = new Set(allModels().map((m) => m.id));
  for (const m of allModels()) {
    if (!m.id.includes("-")) continue;
    const typo = m.id.replace(/-/g, ".");
    const providerIds = new Set((getModels(m.provider as KnownProvider) as Model<Api>[]).map((x) => x.id));
    if (!providerIds.has(typo) && !ids.has(typo)) return { provider: m.provider, id: m.id, typo };
  }
  throw new Error("no hyphenated model id in the bundled registry");
}

describe("validateWorkflowModelsOffline", () => {
  test("built-in (provider, model) pair → no diagnostics", () => {
    const { provider, id } = realPair();
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "${id}", provider: "${provider}"}
`;
    expect(validateWorkflowModelsOffline(yaml).offenders).toEqual([]);
  });

  test("bare model id resolving under some provider → no diagnostics", () => {
    const { id } = realPair();
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "${id}"}
`;
    expect(validateWorkflowModelsOffline(yaml).offenders).toEqual([]);
  });

  test("near-miss of a known model id → severity error with did-you-mean", () => {
    const { provider, id, typo } = nearMissPair();
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "${typo}", provider: "${provider}"}
`;
    const r = validateWorkflowModelsOffline(yaml);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]?.severity).toBe("error");
    expect(r.offenders[0]?.nodeId).toBe("impl");
    expect(r.offenders[0]?.reason).toContain(`did you mean "${provider}/${id}"`);
  });

  test("bare near-miss model id → severity error with did-you-mean", () => {
    const { id, typo } = nearMissPair();
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "${typo}"}
`;
    const r = validateWorkflowModelsOffline(yaml);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]?.severity).toBe("error");
    expect(r.offenders[0]?.reason).toContain(id);
  });

  test("unknown-but-plausible model → severity warning citing enqueue", () => {
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "custom-llm", provider: "mycorp"}
`;
    const r = validateWorkflowModelsOffline(yaml);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]?.severity).toBe("warning");
    expect(r.offenders[0]?.reason).toContain("enqueue");
  });

  test("unknown model under a known provider → severity warning citing enqueue", () => {
    const { provider } = realPair();
    const yaml = `name: t
steps:
  impl: {type: llm, prompt: x, model: "totally-bespoke-finetune-xyz", provider: "${provider}"}
`;
    const r = validateWorkflowModelsOffline(yaml);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]?.severity).toBe("warning");
    expect(r.offenders[0]?.reason).toContain("enqueue");
  });

  test("unparseable source → no diagnostics (parse errors surface elsewhere)", () => {
    expect(validateWorkflowModelsOffline("not a valid workflow").offenders).toEqual([]);
  });
});
