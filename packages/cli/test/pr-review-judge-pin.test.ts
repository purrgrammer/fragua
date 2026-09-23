// The CI review job runs a PINNED RELEASED fragua against a workflow file taken
// from the PR's checkout, so the tree can hand that binary a step type its
// release predates. `pr_review.yaml` uses `judge` steps; no release parses those
// yet, so `.github/workflows/pr-review.yml` runs the judge-free
// `pr_review_nojudge.yaml` instead and the required `review` check keeps working.
//
// That is a duplicated workflow, which is a maintenance cost with a shelf life.
// This test makes the arrangement self-enforcing in BOTH directions: it holds
// the pieces together while the variant is needed, and it fails the moment the
// variant stops being needed — so retiring it is a prompted step rather than
// something everyone forgets.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "@fragua/core";

const root = join(import.meta.dir, "../../..");
const wf = (name: string) => join(root, ".fragua/workflows", name);
const NOJUDGE = wf("pr_review_nojudge.yaml");

const ghaPath = join(root, ".github/workflows/pr-review.yml");
const gha = readFileSync(ghaPath, "utf8");
const canonical = readFileSync(wf("pr_review.yaml"), "utf8");
const canonicalUsesJudge = /^\s*type:\s*judge\s*$/m.test(canonical);

/** What `fragua ci <name>` the review job actually runs. */
const ciTarget = /run:\s*fragua ci (\S+)/.exec(gha)?.[1];

describe("pr-review CI target tracks the judge rollout", () => {
  test("the review job invokes a workflow that exists", () => {
    expect(ciTarget).toBeDefined();
    expect(existsSync(wf(`${ciTarget}.yaml`))).toBe(true);
  });

  if (canonicalUsesJudge) {
    test("while pr_review.yaml uses judge, CI runs the judge-free variant", () => {
      // Pointing CI at pr_review.yaml here fails every PR with
      // `unknown type "judge"` — the released engine cannot parse it.
      expect(ciTarget).toBe("pr_review_nojudge");
      expect(existsSync(NOJUDGE)).toBe(true);
    });

    test("the variant is actually judge-free", () => {
      // Its whole purpose is to be parseable by a release that predates `judge`.
      expect(/^\s*type:\s*judge\s*$/m.test(readFileSync(NOJUDGE, "utf8"))).toBe(false);
    });
  } else {
    test("pr_review.yaml no longer uses judge — retire the variant", () => {
      // Reaching here means a release ships `judge` and the canonical workflow
      // was converted back. Finish the job: point pr-review.yml at `pr_review`
      // (with a setup-fragua pin that understands judge) and delete the copy.
      expect(ciTarget).toBe("pr_review");
      expect(existsSync(NOJUDGE)).toBe(false);
    });
  }
});

describe("the twin's scan prompts stay in step", () => {
  // `pr_review_nojudge.yaml`'s header says a behavioural change to the review
  // pipeline has to land in BOTH files. Nothing enforced that, so tightening a
  // DO-NOT-FLAG rule in one produced silently divergent reviews until someone
  // noticed the results differ. The judge conversion changed how findings are
  // GATED, not how they are SCANNED, so the `*_scan` prompts are the part that
  // must stay identical — this pins exactly that.
  // The one licensed difference: the canonical file prunes findings with a
  // judge, the twin with a `verify` llm step, and each prompt names its own
  // pruner. That is the mechanism difference the twin exists for — normalise it
  // so the gate still catches a real content edit without forcing one of the
  // two files to describe a pruner it does not have.
  const normalisePruner = (prompt: string): string =>
    prompt.replace(/\b(the judge|verify) prunes\b/g, "<pruner> prunes");

  const scanPrompts = (file: string): Map<string, string> => {
    const graph = parseWorkflow(readFileSync(wf(file), "utf8"));
    const out = new Map<string, string>();
    for (const [id, node] of Object.entries(graph.nodes)) {
      if (!id.endsWith("_scan")) continue;
      out.set(id, normalisePruner(String((node.attrs as { prompt?: unknown }).prompt ?? "")));
    }
    return out;
  };

  if (canonicalUsesJudge && existsSync(NOJUDGE)) {
    const canon = scanPrompts("pr_review.yaml");
    const twin = scanPrompts("pr_review_nojudge.yaml");

    test("both files declare the same set of scan steps", () => {
      expect([...twin.keys()].sort()).toEqual([...canon.keys()].sort());
      expect(canon.size).toBeGreaterThan(0);
    });

    for (const [id, prompt] of canon) {
      test(`${id} prompt matches in both files (pruner name aside)`, () => {
        // If this fails: you edited one copy. Apply the same edit to the other,
        // or retire the twin (see its header). If the difference is genuinely
        // judge-vs-verify mechanism, extend `normalisePruner` rather than
        // letting the two drift.
        expect(twin.get(id)).toBe(prompt);
      });
    }
  }
});
