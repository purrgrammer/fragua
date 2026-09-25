// The review lenses used to file confident High/Medium findings on a premise
// about code they never read — engine internals outside the diff and the pack.
// The pack gives a lens the diff, not the engine, so any claim about how
// substitution / the executor / a dependency's types behave is exactly the
// claim it cannot support from the pack. The fix makes an unverifiable premise
// UNABLE to block: every lens records the out-of-pack premise (`premise`) and
// whether it opened the actual file to verify it (`premise_check`); a per-lens
// judge `grounded` question turns that into a probability; and the synthesiser
// (and the gate-less quick tier) caps an ungrounded finding below Critical/High
// and restates it as a question. This test pins that wiring in both workflows.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "@fragua/core";

const root = join(import.meta.dir, "../../..");
const wf = (name: string) => join(root, ".fragua/workflows", name);

const WORKFLOWS = {
  "pr_review.yaml": {
    lenses: ["correctness_lens", "integration_lens", "risk_lens"],
    judges: ["correctness_judge", "integration_judge", "risk_judge"],
    synth: "synthesize",
    quick: "review_quick",
  },
  "review.yaml": {
    lenses: ["correctness_lens", "integration_lens", "risk_lens", "craft_lens"],
    judges: ["correctness_judge", "integration_judge", "risk_judge", "craft_judge"],
    synth: "synthesize",
    quick: "review_quick",
  },
} as const;

const graphOf = (name: string) => parseWorkflow(readFileSync(wf(name), "utf8"));

type Attrs = Record<string, unknown>;
const attrsOf = (name: string, id: string): Attrs => {
  const node = graphOf(name).nodes[id];
  expect(node, `${name}#${id} exists`).toBeDefined();
  return (node?.attrs ?? {}) as Attrs;
};

describe("lenses record whether an out-of-pack premise was verified", () => {
  for (const [file, cfg] of Object.entries(WORKFLOWS)) {
    for (const lens of cfg.lenses) {
      test(`${file}#${lens} declares premise and premise_check string fields`, () => {
        // A finding must carry the load-bearing fact it rests on (`premise`) and
        // the file:line the lens opened to confirm it (`premise_check`) — the raw
        // material the `grounded` judge grades. Without these two fields the cap
        // has nothing to key on.
        const outputs = attrsOf(file, lens)["outputs"] as
          | { findings?: { items?: { fields?: { premise?: { kind?: string }; premise_check?: { kind?: string } } } } }
          | undefined;
        const fields = outputs?.findings?.items?.fields;
        expect(fields?.premise?.kind, `${lens}.premise is a string`).toBe("string");
        expect(fields?.premise_check?.kind, `${lens}.premise_check is a string`).toBe("string");
      });
    }
  }
});

describe("each lens judge asks `grounded` and does not use it to DROP", () => {
  for (const [file, cfg] of Object.entries(WORKFLOWS)) {
    for (const judge of cfg.judges) {
      test(`${file}#${judge} asks a grounded noul that is not a keep gate`, () => {
        const a = attrsOf(file, judge);
        const questions = a["judge_questions"] as { grounded?: { type?: string } } | undefined;
        const keep = a["judge_keep"] as { rules?: Array<{ question?: string }> } | undefined;
        // The question must exist and be a probability (noul), so the synthesiser
        // can threshold it.
        expect(questions?.grounded?.type, `${judge}.grounded is a noul`).toBe("noul");
        // It must NOT be a `keep` rule: an unverified premise is CAPPED (kept at a
        // lower severity, stated as a question), never silently dropped — dropping
        // it would lose real findings and defeat "keep precision on real defects".
        const gated = (keep?.rules ?? []).map((r) => r.question);
        expect(gated).not.toContain("grounded");
      });
    }
  }
});

describe("the synthesiser caps an ungrounded finding below a blocking heading", () => {
  for (const [file, cfg] of Object.entries(WORKFLOWS)) {
    test(`${file}#${cfg.synth} forbids Critical/High for an unverified out-of-pack premise`, () => {
      const prompt = String(attrsOf(file, cfg.synth)["prompt"]);
      expect(prompt).toContain("judge.grounded.noul");
      // The rule must actually deny a blocking severity, not merely mention the
      // signal — this is what makes an unverifiable premise unable to drive a
      // request-changes (verdict greps only `## Critical` / `## High`).
      expect(prompt).toContain("CANNOT be Critical or High");
    });
  }
});

describe("the gate-less quick tier carries the same require-verify-or-cap rule", () => {
  for (const [file, cfg] of Object.entries(WORKFLOWS)) {
    test(`${file}#${cfg.quick} caps out-of-pack premises it did not read`, () => {
      // The quick tier writes the review with no judge, so the rule must live in
      // its prompt directly or an unverified premise could still block there.
      const prompt = String(attrsOf(file, cfg.quick)["prompt"]);
      expect(prompt).toContain("load-bearing premise");
      expect(prompt).toContain("Verify that");
    });
  }
});

describe("both workflows still parse under the pinned engine's parser", () => {
  for (const file of Object.keys(WORKFLOWS)) {
    test(`${file} parses and yields its synthesize node`, () => {
      const g = graphOf(file);
      expect(g.nodes["synthesize"]).toBeDefined();
    });
  }
});
