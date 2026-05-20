// Validator unit tests. Builds Graph objects directly via mkGraph() —
// the parser is exercised in packages/core/test/parser/yaml.test.ts.

import { describe, expect, test } from "bun:test";
import { ValidationError, validate, validateOrThrow } from "../../src/engine/validator.ts";
import { mkGraph } from "../helpers/build-graph.ts";

function codesOf(g: Parameters<typeof validate>[0], opts?: Parameters<typeof validate>[1]): string[] {
  return validate(g, opts).map((d) => d.code);
}

describe("validate — structural", () => {
  test("valid minimal graph has no errors", () => {
    const diags = validate(
      mkGraph({
        nodes: { s: "start", work: "llm", done: "exit" },
        edges: [
          ["s", "work"],
          ["work", "done"],
        ],
      }),
    );
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  test("E001 missing start node", () => {
    const g = mkGraph({ nodes: { a: "llm", done: "exit" } });
    expect(codesOf(g)).toContain("E001");
  });

  test("E002 multiple start nodes", () => {
    const g = mkGraph({
      nodes: { s1: "start", s2: "start", e: "exit" },
    });
    expect(codesOf(g)).toContain("E002");
  });

  test("E003 missing exit node", () => {
    const g = mkGraph({ nodes: { s: "start", a: "llm" }, edges: [["s", "a"]] });
    expect(codesOf(g)).toContain("E003");
  });

  test("E004 edge references undefined node", () => {
    const g = mkGraph({
      nodes: { s: "start", done: "exit" },
      edges: [["s", "ghost"]],
    });
    expect(codesOf(g)).toContain("E004");
  });

  test("W001 orphan node", () => {
    const g = mkGraph({
      nodes: { s: "start", work: "llm", orphan: "llm", done: "exit" },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    const diags = validate(g);
    expect(diags.find((d) => d.code === "W001" && d.nodeId === "orphan")).toBeDefined();
  });

  test("W002 unreachable from start", () => {
    const g = mkGraph({
      nodes: { s: "start", a: "llm", unreachable: "llm", done: "exit" },
      edges: [
        ["s", "a"],
        ["a", "done"],
        ["unreachable", "done"],
      ],
    });
    expect(validate(g).find((d) => d.code === "W002" && d.nodeId === "unreachable")).toBeDefined();
  });

  test("E006 cycle without reachable exit", () => {
    const g = mkGraph({
      nodes: { s: "start", a: "llm", b: "llm", c: "llm", done: "exit" },
      edges: [
        ["s", "a"],
        ["a", "b"],
        ["b", "c"],
        ["c", "a"],
        ["s", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E006");
  });

  test("cycle with reachable exit is fine", () => {
    const g = mkGraph({
      nodes: { s: "start", a: "llm", b: "llm", done: "exit" },
      edges: [
        ["s", "a"],
        ["a", "b"],
        ["b", "a"],
        ["b", "done"],
      ],
    });
    expect(validate(g).find((d) => d.code === "E006")).toBeUndefined();
  });

  test("E012 start node has incoming edges", () => {
    const g = mkGraph({
      nodes: { s: "start", a: "llm", done: "exit" },
      edges: [
        ["s", "a"],
        ["a", "s"],
        ["s", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E012");
  });

  test("E013 exit node has outgoing edges", () => {
    const g = mkGraph({
      nodes: { s: "start", a: "llm", done: "exit" },
      edges: [
        ["s", "done"],
        ["done", "a"],
      ],
    });
    expect(codesOf(g)).toContain("E013");
  });

  test("E028 node id `exit` reserved unless type:exit", () => {
    const g = mkGraph({
      nodes: { s: "start", exit: { type: "llm", attrs: { prompt: "x" } } },
      edges: [["s", "exit"]],
    });
    expect(codesOf(g)).toContain("E028");
  });

  test("E028 not raised for canonical exit:{type:exit}", () => {
    const g = mkGraph({
      nodes: { s: "start", exit: "exit" },
      edges: [["s", "exit"]],
    });
    expect(codesOf(g)).not.toContain("E028");
  });

  test("E030 flags ${{ inputs.x }} referencing an undeclared input", () => {
    const g = mkGraph({
      attrs: { inputs: [{ name: "ticket", type: "string", required: true }] },
      nodes: {
        s: "start",
        work: { type: "llm", attrs: { prompt: "fix ${{ inputs.ticket }} in ${{ inputs.repo }}" } },
        done: "exit",
      },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    const e030 = validate(g).filter((d) => d.code === "E030");
    expect(e030).toHaveLength(1);
    expect(e030[0]?.message).toContain("repo");
  });

  test("E030 not raised when every input reference is declared", () => {
    const g = mkGraph({
      attrs: { inputs: [{ name: "ticket", type: "string", required: true }] },
      nodes: {
        s: "start",
        work: { type: "llm", attrs: { prompt: "fix ${{ inputs.ticket }}" } },
        done: "exit",
      },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(codesOf(g)).not.toContain("E030");
  });

  test("E030 scans tool_command and text fields too", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        run: { type: "tool", attrs: { tool_command: "deploy ${{ inputs.env }}" } },
        done: "exit",
      },
      edges: [
        ["s", "run"],
        ["run", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E030");
  });

  test("strict mode promotes warnings to errors", () => {
    const g = mkGraph({
      nodes: { s: "start", work: "llm", orphan: "llm", done: "exit" },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    const orphan = validate(g, { strict: true }).find((d) => d.code === "W001");
    expect(orphan?.severity).toBe("error");
  });
});

describe("validate — E031 retry gate without max_retries", () => {
  test("goal_gate=true + retry_target set but no max_retries → E031 error", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        gate: { type: "llm", attrs: { goal_gate: true, retry_target: "fix" } },
        fix: "llm",
        done: "exit",
      },
      edges: [
        ["s", "gate"],
        ["gate", "done"],
        ["fix", "gate"],
      ],
    });
    const e031 = validate(g).filter((d) => d.code === "E031");
    expect(e031).toHaveLength(1);
    expect(e031[0]?.nodeId).toBe("gate");
    expect(e031[0]?.severity).toBe("error");
  });

  test("goal_gate=true + retry_target set WITH max_retries → no E031", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        gate: { type: "llm", attrs: { goal_gate: true, retry_target: "fix", max_retries: 2 } },
        fix: "llm",
        done: "exit",
      },
      edges: [
        ["s", "gate"],
        ["gate", "done"],
        ["fix", "gate"],
      ],
    });
    expect(codesOf(g)).not.toContain("E031");
  });

  test("goal_gate=true WITHOUT retry_target does not trip E031 (W007 fires instead)", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        gate: { type: "llm", attrs: { goal_gate: true } },
        done: "exit",
      },
      edges: [
        ["s", "gate"],
        ["gate", "done"],
      ],
    });
    // E031 only fires when retry_target IS set (i.e. authored via retry:).
    expect(codesOf(g)).not.toContain("E031");
    expect(codesOf(g)).toContain("W007");
  });
});

describe("validate — handler lints", () => {
  test("E008 tool node missing tool_command", () => {
    const g = mkGraph({
      nodes: { s: "start", run: { type: "tool", attrs: { kind: "tool" } }, done: "exit" },
      edges: [
        ["s", "run"],
        ["run", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E008");
  });

  test("E009 human node with no outgoing edges", () => {
    const g = mkGraph({
      nodes: { s: "start", gate: { type: "human", attrs: { kind: "human" } }, done: "exit" },
      edges: [["s", "gate"]],
    });
    const e009 = validate(g).find((d) => d.code === "E009");
    expect(e009?.severity).toBe("error");
    expect(e009?.nodeId).toBe("gate");
  });

  test("W009 llm with empty prompt and empty label", () => {
    const g = mkGraph({
      nodes: { s: "start", work: "llm", done: "exit" },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(validate(g).find((d) => d.code === "W009" && d.nodeId === "work")).toBeDefined();
  });

  test("W009 not raised when prompt is set", () => {
    const g = mkGraph({
      nodes: { s: "start", work: { type: "llm", attrs: { prompt: "x" } }, done: "exit" },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(validate(g).some((d) => d.code === "W009")).toBe(false);
  });
});

describe("validate — retry / goal-gate lints", () => {
  test("E011 node retry_target references undefined node", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        review: { type: "llm", attrs: { goal_gate: true, retry_target: "ghost" } },
        done: "exit",
      },
      edges: [
        ["s", "review"],
        ["review", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E011");
  });

  test("E011 not raised when retry_target points at an existing node", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        impl: "llm",
        review: { type: "llm", attrs: { prompt: "r", goal_gate: true, retry_target: "impl" } },
        done: "exit",
      },
      edges: [
        ["s", "impl"],
        ["impl", "review"],
        ["review", "done"],
      ],
    });
    expect(validate(g).some((d) => d.code === "E011")).toBe(false);
  });

  test("W007 goal_gate node with no retarget anywhere", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        review: { type: "llm", attrs: { prompt: "r", goal_gate: true } },
        done: "exit",
      },
      edges: [
        ["s", "review"],
        ["review", "done"],
      ],
    });
    expect(codesOf(g)).toContain("W007");
  });

  test("E027 summary= without thread_id", () => {
    const g = mkGraph({
      nodes: { s: "start", work: { type: "llm", attrs: { prompt: "x", summary: "medium" } }, done: "exit" },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E027");
  });

  test("E027 not raised when summary paired with thread_id", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        work: { type: "llm", attrs: { prompt: "x", summary: "medium", thread_id: "dev" } },
        done: "exit",
      },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(validate(g).some((d) => d.code === "E027")).toBe(false);
  });
});

describe("validate — routing lints (E017–E024)", () => {
  test("E017 routing node has outgoing edge with outcome=", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        router: { type: "llm", attrs: { prompt: "x", routes: ["a"] } },
        a: "llm",
        done: "exit",
      },
      edges: [
        ["s", "router"],
        ["router", "a", { outcome: "success" }],
        ["a", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E017");
  });

  test("E018 edge with both outcome= and route=", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        router: { type: "llm", attrs: { prompt: "x", routes: ["a"] } },
        a: "llm",
        done: "exit",
      },
      edges: [
        ["s", "router"],
        ["router", "a", { outcome: "success", route: "a" }],
        ["a", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E018");
  });

  test("E019 edge route= not in source routes=", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        router: { type: "llm", attrs: { prompt: "x", routes: ["a", "b"] } },
        a: "llm",
        done: "exit",
      },
      edges: [
        ["s", "router"],
        ["router", "a", { route: "c" }],
        ["a", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E019");
  });

  test("E021 declared route has no matching outgoing edge", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        router: { type: "llm", attrs: { prompt: "x", routes: ["a", "b"] } },
        a: "llm",
        done: "exit",
      },
      edges: [
        ["s", "router"],
        ["router", "a", { route: "a" }],
        ["a", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E021");
  });

  test("E022 human node without routes=", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        gate: { type: "human", attrs: { kind: "human" } },
        a: "llm",
        done: "exit",
      },
      edges: [
        ["s", "gate"],
        ["gate", "a"],
        ["a", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E022");
  });

  test("E023 goal_gate=true combined with routes= is mutex", () => {
    const g = mkGraph({
      nodes: {
        s: "start",
        gate: { type: "llm", attrs: { prompt: "x", goal_gate: true, routes: ["a"] } },
        a: "llm",
        done: "exit",
      },
      edges: [
        ["s", "gate"],
        ["gate", "a", { route: "a" }],
        ["a", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E023");
  });

  test("E024 duplicate outcome= from same source", () => {
    const g = mkGraph({
      nodes: { s: "start", a: "llm", b: "llm", c: "llm", done: "exit" },
      edges: [
        ["s", "a"],
        ["a", "b", { outcome: "success" }],
        ["a", "c", { outcome: "success" }],
        ["b", "done"],
        ["c", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E024");
  });

  test("E026 text= on non-human node", () => {
    const g = mkGraph({
      nodes: { s: "start", work: { type: "llm", attrs: { prompt: "x", text: "operator prompt" } }, done: "exit" },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(codesOf(g)).toContain("E026");
  });
});

describe("validateOrThrow", () => {
  test("ok graph does not throw", () => {
    const g = mkGraph({
      nodes: { s: "start", work: { type: "llm", attrs: { prompt: "x" } }, done: "exit" },
      edges: [
        ["s", "work"],
        ["work", "done"],
      ],
    });
    expect(() => validateOrThrow(g)).not.toThrow();
  });

  test("missing start throws ValidationError", () => {
    const g = mkGraph({ nodes: { a: "llm", done: "exit" } });
    try {
      validateOrThrow(g);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
    }
  });
});
