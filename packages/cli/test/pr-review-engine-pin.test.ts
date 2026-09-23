// The CI review job runs a PINNED RELEASED fragua against a workflow file taken
// from the PR's checkout, so the tree can hand that binary a step type its
// release predates. That drift is the single largest failure class this check
// has had: 29 of 30 consecutive `PR review` failures were one released engine
// meeting one `type: judge` step it could not parse — including on the PR that
// introduced the step type.
//
// The fix for that episode was a judge-free copy of the workflow; the fix for
// the CLASS is this test. It pins the invariant directly: whatever step types
// `pr_review.yaml` uses, the version in `with: version:` must be a release that
// parses them. Adding a step type without cutting a release fails the build
// here instead of failing every PR silently.
//
// It also pins the never-stall arithmetic, because that is the other thing
// nobody notices until a run has been silent for twenty minutes: the `timeout`
// wrapper must fire before GitHub kills the job, or fragua never gets to run
// its shutdown path and the run exports no bundle.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow } from "@fragua/core";

const root = join(import.meta.dir, "../../..");
const wf = (name: string) => join(root, ".fragua/workflows", name);

const gha = readFileSync(join(root, ".github/workflows/pr-review.yml"), "utf8");
const canonicalSrc = readFileSync(wf("pr_review.yaml"), "utf8");

/** What `fragua ci <name>` the review job actually runs. */
const ciTarget = /^\s*fragua ci ([A-Za-z_][\w-]*)/m.exec(gha)?.[1];
/** The binary the action installs — the SHA next to it pins the ACTION, not this. */
const pinnedVersion = /version:\s*v(\d+)\.(\d+)\.(\d+)/.exec(gha);

/** First release that parses a given step type. */
const STEP_TYPE_SINCE: Record<string, [number, number, number]> = {
  judge: [0, 11, 0],
};

const cmp = (a: readonly number[], b: readonly number[]): number =>
  (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);

describe("the pinned review engine parses the workflow it is given", () => {
  test("the review job invokes a workflow that exists", () => {
    expect(ciTarget).toBe("pr_review");
    expect(existsSync(wf(`${ciTarget}.yaml`))).toBe(true);
  });

  test("the binary is pinned, not floating", () => {
    // Without `with: version:` the action resolves `latest` at run time and the
    // "reproducible engine" drifts with every release.
    expect(pinnedVersion).not.toBeNull();
  });

  const pinned = pinnedVersion
    ? ([Number(pinnedVersion[1]), Number(pinnedVersion[2]), Number(pinnedVersion[3])] as const)
    : ([0, 0, 0] as const);

  for (const [stepType, since] of Object.entries(STEP_TYPE_SINCE)) {
    const used = new RegExp(`^\\s*type:\\s*${stepType}\\s*$`, "m").test(canonicalSrc);
    test(`pr_review.yaml uses \`${stepType}\` (${used}) ⇒ pin is ≥ v${since.join(".")}`, () => {
      if (!used) return;
      // If this fails: cut a release that ships the step type, then bump BOTH
      // pins in pr-review.yml — the action SHA and `with: version:`.
      expect(cmp(pinned, since)).toBeGreaterThanOrEqual(0);
    });
  }

  test("the judge-free twin is gone", () => {
    // It existed only while no release parsed `judge`. Now one does, and a
    // second copy of the pipeline is a drift surface with no remaining purpose.
    expect(existsSync(wf("pr_review_nojudge.yaml"))).toBe(false);
  });
});

describe("the review job cannot stall silently", () => {
  const wrapperMinutes = Number(/timeout --signal=INT --kill-after=(\d+)s (\d+)m/.exec(gha)?.[2] ?? NaN);
  const killAfterSeconds = Number(/--kill-after=(\d+)s/.exec(gha)?.[1] ?? NaN);
  const jobMinutes = Number(/timeout-minutes:\s*(\d+)/.exec(gha)?.[1] ?? NaN);

  test("`fragua ci` runs under a `timeout(1)` wrapper that SIGINTs it", () => {
    // Per-node `timeout-minutes` does NOT bound a fan-out branch: a timeout
    // there is an abort, re-dispatched with a fresh timer up to five times and
    // then paused — and a paused run in CI has no responder. The wrapper is the
    // guarantee, and --signal=INT is what lets fragua's `finally` export the
    // bundle instead of dying mid-syscall.
    expect(gha).toContain("timeout --signal=INT --kill-after=");
    expect(Number.isNaN(wrapperMinutes)).toBe(false);
  });

  test("fragua wins the race against GitHub's kill", () => {
    // The job timeout is a backstop. If it fires first, the process is killed
    // externally, no bundle is written, and the failure has no forensics.
    expect(jobMinutes).toBeGreaterThan(wrapperMinutes + killAfterSeconds / 60);
  });

  test("a failed review still posts, and never on a cancellation", () => {
    // `if:` with no status function is implicitly `success() && …`, which is
    // false after a failed step — the whole fallback would be dead YAML.
    expect(gha).toContain("if: failure() && steps.review.outcome == 'failure'");
    expect(gha).toMatch(/id:\s*review/);
    expect(gha).toContain("gh pr comment");
  });

  test("the bundle uploads whatever the outcome", () => {
    expect(gha).toMatch(/if:\s*always\(\)/);
  });
});

describe("every step of the CI review workflow is bounded", () => {
  const graph = parseWorkflow(canonicalSrc);

  // A `parallel` node's `timeout-minutes` is the deadline for each branch
  // SUB-node, so a branch member inherits its region's bound rather than
  // declaring one. Walk each branch from its head to the join.
  const successorsOf = (id: string): string[] => graph.edges.filter((e) => e.from === id).map((e) => e.to);

  const underParallel = new Set<string>();
  for (const [pid, node] of Object.entries(graph.nodes)) {
    const branches = (node.attrs as { branches?: unknown }).branches;
    if (!Array.isArray(branches)) continue;
    const join = graph.edges.find((e) => e.from === pid && (e.attrs as { outcome?: string }).outcome === "success")?.to;
    const stack = [...(branches as string[])];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (cur === undefined || cur === join || underParallel.has(cur) || graph.nodes[cur] === undefined) continue;
      underParallel.add(cur);
      stack.push(...successorsOf(cur));
    }
  }

  for (const [id, node] of Object.entries(graph.nodes)) {
    if (node.type === "start" || node.type === "exit") continue;
    if (underParallel.has(id)) continue;
    test(`${id} declares timeout-minutes`, () => {
      // An unbounded node is how a review goes silent: fragua's own timeout
      // never fires and the only watchdog left is GitHub's external kill.
      expect((node.attrs as { max_ms?: number }).max_ms ?? 0).toBeGreaterThan(0);
    });
  }

  test("the fan-out region is bounded", () => {
    const parallel = Object.values(graph.nodes).find((n) => n.type === "parallel");
    expect(parallel).toBeDefined();
    expect((parallel?.attrs as { max_ms?: number }).max_ms ?? 0).toBeGreaterThan(0);
  });

  test("budget-policy is set and is not `pause`", () => {
    // Unset means `pause`, and `fragua ci` exits non-zero on a paused run
    // without posting: a budget breach would swallow the whole review.
    const policy = (graph.attrs as { budget_policy?: string }).budget_policy;
    expect(policy).toBeDefined();
    expect(policy).not.toBe("pause");
  });

  test("there is no goal gate — exhausting one pauses, and CI cannot answer", () => {
    expect(graph.nodes).toBeDefined();
    for (const [id, node] of Object.entries(graph.nodes)) {
      expect(`${id}:${(node.attrs as { goal_gate?: boolean }).goal_gate === true}`).toBe(`${id}:false`);
    }
  });
});

describe("review.yaml converges on the same terms", () => {
  // The local sibling has a human at the end, so a pause is answerable and it
  // needs no `timeout(1)` wrapper. Everything else that makes a run go quiet —
  // an unbounded node, a default `pause` budget, a goal gate that exhausts into
  // a pause — applies here too.
  const graph = parseWorkflow(readFileSync(wf("review.yaml"), "utf8"));

  test("budget-policy is set and is not `pause`", () => {
    const policy = (graph.attrs as { budget_policy?: string }).budget_policy;
    expect(policy).toBeDefined();
    expect(policy).not.toBe("pause");
  });

  test("no goal gate", () => {
    const gates = Object.entries(graph.nodes)
      .filter(([, n]) => (n.attrs as { goal_gate?: boolean }).goal_gate === true)
      .map(([id]) => id);
    expect(gates).toEqual([]);
  });

  test("the fan-out region is bounded", () => {
    const parallel = Object.values(graph.nodes).find((n) => n.type === "parallel");
    expect((parallel?.attrs as { max_ms?: number })?.max_ms ?? 0).toBeGreaterThan(0);
  });

  test("both workflows build their pack with the shared script", () => {
    // One builder, two entry forms. A second copy would drift the moment one
    // lens prompt starts describing a file the other pack doesn't produce.
    expect(existsSync(join(root, ".fragua/scripts/review/build-pack.sh"))).toBe(true);
    for (const name of ["pr_review.yaml", "review.yaml"]) {
      expect(readFileSync(wf(name), "utf8")).toContain("build-pack.sh");
    }
  });
});
