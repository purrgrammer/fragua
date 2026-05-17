import { describe, expect, test } from "bun:test";
import { ValidationError, validate, validateOrThrow } from "../../src/engine/validator.ts";
import { parseDotSource } from "../../src/parser/parser.ts";

function codes(dots: string): string[] {
  return validate(parseDotSource(dots)).map((d) => d.code);
}

describe("validate", () => {
  test("valid minimal graph has no errors", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          start [shape=Mdiamond]
          work
          done [shape=Msquare]
          start -> work -> done
        }
      `),
    );
    expect(diags.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  test("E001 missing start node", () => {
    expect(codes(`digraph { a; done [shape=Msquare] }`)).toContain("E001");
  });

  test("E002 multiple start nodes", () => {
    expect(codes(`digraph { s1 [shape=Mdiamond]; s2 [shape=Mdiamond]; e [shape=Msquare] }`)).toContain("E002");
  });

  test("E003 missing exit node", () => {
    expect(codes(`digraph { s [shape=Mdiamond]; s -> a }`)).toContain("E003");
  });

  test("E004 edge references undefined node", () => {
    // Parser auto-creates nodes, but if edges reference literal-only IDs in
    // isolation we still detect them. Construct graph manually to exercise.
    const diags = validate({
      id: "G",
      directed: true,
      attrs: {},
      nodes: {
        s: { id: "s", shape: "Mdiamond", attrs: {}, classes: [] },
        done: { id: "done", shape: "Msquare", attrs: {}, classes: [] },
      },
      edges: [{ from: "s", to: "ghost", attrs: {} }],
      subgraphs: [],
    });
    expect(diags.find((d) => d.code === "E004")).toBeDefined();
  });

  test("W001 orphan node (not start)", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work
          orphan
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const orphanWarn = diags.find((d) => d.code === "W001" && d.nodeId === "orphan");
    expect(orphanWarn).toBeDefined();
  });

  test("W002 unreachable from start", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a
          unreachable
          b [shape=Msquare]
          s -> a -> b
          unreachable -> b
        }
      `),
    );
    expect(diags.find((d) => d.code === "W002" && d.nodeId === "unreachable")).toBeDefined();
  });

  test("W003 all-conditional edges without fail catch-all", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          mid
          done [shape=Msquare]
          s -> mid
          mid -> done [condition="outcome=success"]
        }
      `),
    );
    expect(diags.find((d) => d.code === "W003")).toBeDefined();
  });

  test("W003 suppressed when an outcome=fail edge exists", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          mid
          done [shape=Msquare]
          fix
          s -> mid
          mid -> done [condition="outcome=success"]
          mid -> fix [condition="outcome=fail"]
        }
      `),
    );
    expect(diags.find((d) => d.code === "W003")).toBeUndefined();
  });

  test("E005 references unknown node via $nodeId.output", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          plan [prompt="do something"]
          implement [prompt="based on $ghost.output do the thing"]
          done [shape=Msquare]
          s -> plan -> implement -> done
        }
      `),
    );
    expect(diags.find((d) => d.code === "E005")).toBeDefined();
  });

  test("E006 cycle without reachable exit", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a; b; c
          done [shape=Msquare]
          s -> a -> b -> c -> a
          s -> done
        }
      `),
    );
    expect(diags.find((d) => d.code === "E006")).toBeDefined();
  });

  test("cycle with reachable exit is fine", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a; b
          done [shape=Msquare]
          s -> a -> b -> a
          b -> done
        }
      `),
    );
    expect(diags.find((d) => d.code === "E006")).toBeUndefined();
  });

  test("strict mode promotes warnings to errors", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work
          done [shape=Msquare]
          s -> work -> done
          orphan
        }
      `),
      { strict: true },
    );
    const orphan = diags.find((d) => d.code === "W001");
    expect(orphan?.severity).toBe("error");
  });
});

describe("HITL (wait.human) lint rules", () => {
  test("E009: hexagon node with no outgoing edges", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon]
          done [shape=Msquare]
          s -> gate
        }
      `),
    );
    const e009 = diags.find((d) => d.code === "E009");
    expect(e009).toBeDefined();
    expect(e009?.severity).toBe("error");
    expect(e009?.nodeId).toBe("gate");
    expect(e009?.message).toMatch(/no outgoing edges/);
  });

  test("E009 not raised for hexagon with at least one outgoing edge", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon]
          done [shape=Msquare]
          s -> gate -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E009")).toBe(false);
  });

  test("E010: hexagon outgoing edges with colliding accelerator keys", () => {
    // Both `Approve` and `Acknowledge` start with A → collision.
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon]
          a [shape=box]
          b [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a [label="Approve"]
          gate -> b [label="Acknowledge"]
          a -> done
          b -> done
        }
      `),
    );
    const e010 = diags.find((d) => d.code === "E010");
    expect(e010).toBeDefined();
    expect(e010?.severity).toBe("error");
    expect(e010?.nodeId).toBe("gate");
    expect(e010?.message).toContain('"A"');
    expect(e010?.message).toMatch(/Approve/);
    expect(e010?.message).toMatch(/Acknowledge/);
  });

  test("E010 not raised when authors disambiguate via [K] prefixes", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon]
          a [shape=box]
          b [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a [label="[A] Approve"]
          gate -> b [label="[B] Acknowledge"]
          a -> done
          b -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E010")).toBe(false);
  });

  test("E010 not raised for a single outgoing edge (no collision possible)", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon]
          done [shape=Msquare]
          s -> gate -> done [label="Continue"]
        }
      `),
    );
    expect(diags.some((d) => d.code === "E010")).toBe(false);
  });

  test("W004: legacy context.hitl.* condition on a hexagon outgoing edge", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon]
          a [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a    [condition="context.hitl.gate=APPROVED"]
          gate -> done
          a -> done
        }
      `),
    );
    const w004 = diags.find((d) => d.code === "W004");
    expect(w004).toBeDefined();
    expect(w004?.severity).toBe("warning");
    expect(w004?.edge).toEqual({ from: "gate", to: "a" });
    expect(w004?.message).toMatch(/legacy/);
  });

  test("W004 not raised on non-hexagon edges or non-hitl conditions", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon]
          a [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a    [label="[A] Approve"]
          gate -> done [label="[R] Reject"]
          a -> done    [condition="outcome=success"]
        }
      `),
    );
    expect(diags.some((d) => d.code === "W004")).toBe(false);
  });

  test("E010 reports unique-key sets independently per hexagon node", () => {
    // Two hexagons; only the second has a collision.
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          g1 [shape=hexagon]
          g2 [shape=hexagon]
          a [shape=box]
          b [shape=box]
          done [shape=Msquare]
          s -> g1
          g1 -> g2 [label="[Y] Yes"]
          g1 -> done [label="[N] No"]
          g2 -> a [label="Save"]
          g2 -> b [label="Send"]
          a -> done
          b -> done
        }
      `),
    );
    const e010s = diags.filter((d) => d.code === "E010");
    expect(e010s).toHaveLength(1);
    expect(e010s[0]?.nodeId).toBe("g2");
  });
});

describe("goal-gate / retry-target lints (attractor §3.4)", () => {
  test("E011: node retry_target references undefined node", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=box, goal_gate=true, retry_target=ghost]
          done [shape=Msquare]
          s -> gate -> done
        }
      `),
    );
    const e011 = diags.find((d) => d.code === "E011");
    expect(e011).toBeDefined();
    expect(e011?.severity).toBe("error");
    expect(e011?.nodeId).toBe("gate");
    expect(e011?.message).toMatch(/ghost/);
  });

  test("E011: graph retry_target references undefined node", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          graph [retry_target=phantom]
          s [shape=Mdiamond]
          gate [shape=box, goal_gate=true]
          done [shape=Msquare]
          s -> gate -> done
        }
      `),
    );
    const e011 = diags.find((d) => d.code === "E011" && d.message.includes("graph"));
    expect(e011).toBeDefined();
    expect(e011?.severity).toBe("error");
    expect(e011?.message).toMatch(/phantom/);
  });

  test("E011 not raised when retry_target points at an existing node", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          fix
          gate [shape=box, goal_gate=true, retry_target=fix]
          done [shape=Msquare]
          s -> gate -> done
          fix -> gate
        }
      `),
    );
    expect(diags.some((d) => d.code === "E011")).toBe(false);
  });

  test("W007: goal_gate node with no retarget anywhere", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=box, goal_gate=true]
          done [shape=Msquare]
          s -> gate -> done
        }
      `),
    );
    const w007 = diags.find((d) => d.code === "W007");
    expect(w007).toBeDefined();
    expect(w007?.severity).toBe("warning");
    expect(w007?.nodeId).toBe("gate");
  });

  test("W007 not raised when graph-level retry_target is set", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          graph [retry_target=fix]
          s [shape=Mdiamond]
          fix
          gate [shape=box, goal_gate=true]
          done [shape=Msquare]
          s -> gate -> done
          fix -> gate
        }
      `),
    );
    expect(diags.some((d) => d.code === "W007")).toBe(false);
  });

  test("W007 not raised when gate-level retry_target is set", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          fix
          gate [shape=box, goal_gate=true, retry_target=fix]
          done [shape=Msquare]
          s -> gate -> done
          fix -> gate
        }
      `),
    );
    expect(diags.some((d) => d.code === "W007")).toBe(false);
  });

  test("W007 not raised when node has no goal_gate", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          plain [shape=box]
          done [shape=Msquare]
          s -> plain -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "W007")).toBe(false);
  });
});

describe("structural lints (attractor §11.2)", () => {
  test("E012: start node has incoming edges", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a -> done
          a -> s
        }
      `),
    );
    const e012 = diags.find((d) => d.code === "E012");
    expect(e012).toBeDefined();
    expect(e012?.severity).toBe("error");
    expect(e012?.nodeId).toBe("s");
  });

  test("E013: exit node has outgoing edges", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          done [shape=Msquare]
          extra [shape=box]
          s -> done -> extra
        }
      `),
    );
    const e013 = diags.find((d) => d.code === "E013");
    expect(e013).toBeDefined();
    expect(e013?.nodeId).toBe("done");
  });

  test("E014: edge condition fails to parse", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a [condition="this is not valid && && malformed"]
          a -> done
        }
      `),
    );
    const e014 = diags.find((d) => d.code === "E014");
    expect(e014).toBeDefined();
  });

  test("W009: codergen node with empty prompt and empty label", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          empty [shape=box]
          done [shape=Msquare]
          s -> empty -> done
        }
      `),
    );
    const w009 = diags.find((d) => d.code === "W009");
    expect(w009).toBeDefined();
    expect(w009?.nodeId).toBe("empty");
  });

  test("W009 not raised when prompt or label is set", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a [shape=box, label="Do the thing"]
          done [shape=Msquare]
          s -> a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "W009")).toBe(false);
  });

  test("W010: fidelity not a known mode", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, fidelity="compcat"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const w010 = diags.find((d) => d.code === "W010");
    expect(w010).toBeDefined();
    expect(w010?.nodeId).toBe("work");
  });

  test("W010: graph default_fidelity not a known mode", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          graph [default_fidelity="weird"]
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "W010" && d.message.includes("graph"))).toBe(true);
  });
});

describe("stylesheet lint (attractor §8)", () => {
  test("E015: malformed model_stylesheet", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          graph [model_stylesheet="* { llm_model bad }"]
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a -> done
        }
      `),
    );
    const e015 = diags.find((d) => d.code === "E015");
    expect(e015).toBeDefined();
    expect(e015?.severity).toBe("error");
  });

  test("E015 not raised when stylesheet is empty or absent", () => {
    const diags1 = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a -> done
        }
      `),
    );
    expect(diags1.some((d) => d.code === "E015")).toBe(false);

    const diags2 = validate(
      parseDotSource(`
        digraph {
          graph [model_stylesheet=""]
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a -> done
        }
      `),
    );
    expect(diags2.some((d) => d.code === "E015")).toBe(false);
  });

  test("E015 not raised on a well-formed stylesheet", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          graph [model_stylesheet="* { llm_model: opus; llm_provider: anthropic; }"]
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E015")).toBe(false);
  });
});

describe("retry-policy lints (attractor §3.6)", () => {
  test("W008: node retry_policy is not a known preset name", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, retry_policy="paranoid"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const w008 = diags.find((d) => d.code === "W008");
    expect(w008).toBeDefined();
    expect(w008?.severity).toBe("warning");
    expect(w008?.nodeId).toBe("work");
    expect(w008?.message).toMatch(/paranoid/);
  });

  test("W008 not raised for known preset names", () => {
    for (const preset of ["none", "standard", "aggressive", "linear", "patient"]) {
      const diags = validate(
        parseDotSource(`
          digraph {
            s [shape=Mdiamond]
            work [shape=box, retry_policy="${preset}"]
            done [shape=Msquare]
            s -> work -> done
          }
        `),
      );
      expect(diags.some((d) => d.code === "W008")).toBe(false);
    }
  });

  test("W008: graph default_retry_policy not a known preset", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          graph [default_retry_policy="quirky"]
          s [shape=Mdiamond]
          work [shape=box]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const w008 = diags.find((d) => d.code === "W008" && d.message.includes("graph"));
    expect(w008).toBeDefined();
  });

  test("W011: codergen node declares bare `model` without llm_ prefix", () => {
    // Repro for run 01kqwzpt0hyfws0a0j: orchestrate.dot used `model = "claude-opus-4-7"`
    // and the backend (which only reads `llm_model`) silently fell through to
    // the daemon default. The validator must warn loudly at upload time.
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, model="claude-opus-4-7", prompt="go"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const w011 = diags.find((d) => d.code === "W011" && d.nodeId === "work");
    expect(w011).toBeDefined();
    expect(w011?.severity).toBe("warning");
    expect(w011?.message).toMatch(/llm_model/);
  });

  test("W011: codergen node declares bare `provider` without llm_ prefix", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, provider="anthropic", prompt="go"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const w011 = diags.find((d) => d.code === "W011" && d.nodeId === "work");
    expect(w011).toBeDefined();
    expect(w011?.message).toMatch(/llm_provider/);
  });

  test("W011 not raised when llm_model is set explicitly", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, llm_model="claude-opus-4-7", prompt="go"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "W011")).toBe(false);
  });

  test("W011 not raised when a model_stylesheet covers the node", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          model_stylesheet="* { llm_model: claude-opus-4-7; }"
          s [shape=Mdiamond]
          work [shape=box, model="claude-opus-4-7", prompt="go"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "W011")).toBe(false);
  });
});

describe("type override + unknown-attribute lints (attractor §2.6 / §4.2)", () => {
  test("E016: type= references an unknown handler", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [type="codrgen"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const e016 = diags.find((d) => d.code === "E016");
    expect(e016).toBeDefined();
    expect(e016?.severity).toBe("error");
    expect(e016?.nodeId).toBe("work");
    expect(e016?.message).toMatch(/codrgen/);
  });

  test("E016 not raised when type= names a known handler", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [type="codergen"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E016")).toBe(false);
  });

  test("W012: type= and shape resolve to different handlers", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon, type="codergen", prompt="re-purpose hexagon"]
          done [shape=Msquare]
          s -> gate -> done
        }
      `),
    );
    const w012 = diags.find((d) => d.code === "W012");
    expect(w012).toBeDefined();
    expect(w012?.severity).toBe("warning");
    expect(w012?.nodeId).toBe("gate");
    expect(w012?.message).toMatch(/overrides/);
  });

  test("W012 not raised when type= matches the shape's canonical handler (redundant-explicit)", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, type="codergen"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "W012")).toBe(false);
  });

  test("W013: unrecognised node attribute", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [goalgate=true]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const w013 = diags.find((d) => d.code === "W013" && d.nodeId === "work");
    expect(w013).toBeDefined();
    expect(w013?.severity).toBe("warning");
    expect(w013?.message).toMatch(/goalgate/);
  });

  test("W013: unrecognised edge attribute", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work
          done [shape=Msquare]
          s -> work -> done [foo="bar"]
        }
      `),
    );
    const w013 = diags.find((d) => d.code === "W013" && d.edge?.to === "done");
    expect(w013).toBeDefined();
    expect(w013?.message).toMatch(/foo/);
  });

  test("W013: unrecognised graph attribute", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          graph [budjet_usd=5.0]
          s [shape=Mdiamond]
          done [shape=Msquare]
          s -> done
        }
      `),
    );
    const w013 = diags.find((d) => d.code === "W013" && d.message.includes("graph"));
    expect(w013).toBeDefined();
    expect(w013?.message).toMatch(/budjet_usd/);
  });

  test("W013 not raised for canonical attributes", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          graph [goal="x", default_fidelity="compact", budget_usd=5.0]
          s [shape=Mdiamond]
          work [prompt="hi", allowed_tools="read", llm_model="claude-sonnet-4-6"]
          done [shape=Msquare]
          s -> work -> done [label="ok", condition="outcome=success", weight=1]
        }
      `),
    );
    expect(diags.some((d) => d.code === "W013")).toBe(false);
  });

  test("W014: auto_status on a node", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [auto_status=true, prompt="hi"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const w014 = diags.find((d) => d.code === "W014");
    expect(w014).toBeDefined();
    expect(w014?.severity).toBe("warning");
    expect(w014?.nodeId).toBe("work");
    expect(w014?.message).toMatch(/SPEC\.md §5/);
  });

  test("W014: loop_restart on an edge", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          a [prompt="a"]
          b [prompt="b"]
          done [shape=Msquare]
          s -> a -> b -> done
          b -> a [loop_restart=true, label="restart"]
        }
      `),
    );
    const w014 = diags.find((d) => d.code === "W014");
    expect(w014).toBeDefined();
    expect(w014?.edge).toEqual({ from: "b", to: "a" });
    expect(w014?.message).toMatch(/loop_restart/);
  });

  test("W014 does NOT double-fire with W013 (attractor-only attrs are in the whitelist)", () => {
    const diags = validate(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work [auto_status=true, prompt="hi"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    // auto_status: one W014, zero W013.
    expect(diags.filter((d) => d.code === "W014").length).toBe(1);
    expect(diags.some((d) => d.code === "W013" && d.message.includes("auto_status"))).toBe(false);
  });
});

describe("W015 removed", () => {
  // W015 used to warn that a tripleoctagon (parallel.fan_in) with prompt=
  // had a dead prompt. The G3 design (separate proposal) makes fan-in LLM
  // evaluation a first-class feature, so the warning is actively harmful.
  // Dropped by docs/proposals/codergen-context-output-tools.md §5.1.
  function fanInGraph(extraAttrs: string): string {
    return `
      digraph {
        start [shape=Mdiamond]
        fan   [shape=component]
        a     [prompt="a"]
        b     [prompt="b"]
        join  [shape=tripleoctagon${extraAttrs}]
        done  [shape=Msquare]
        start -> fan -> a -> join -> done
        fan -> b -> join
      }
    `;
  }

  test("tripleoctagon prompt= no longer warns", () => {
    const diags = validate(parseDotSource(fanInGraph(`, prompt="synthesize the branches"`)));
    expect(diags.some((d) => d.code === "W015")).toBe(false);
  });

  test("bare tripleoctagon (no prompt) still clean", () => {
    const diags = validate(parseDotSource(fanInGraph("")));
    expect(diags.some((d) => d.code === "W015")).toBe(false);
  });
});

describe("E017 output_schema", () => {
  function nodeWithSchema(attr: string): string {
    return `
      digraph {
        start [shape=Mdiamond]
        work  [${attr}]
        done  [shape=Msquare]
        start -> work -> done
      }
    `;
  }

  test("rejects non-JSON output_schema", () => {
    const diags = validate(parseDotSource(nodeWithSchema(`prompt="x", output_schema="not json"`)));
    const e017 = diags.filter((d) => d.code === "E017");
    expect(e017.length).toBe(1);
    expect(e017[0]?.severity).toBe("error");
    expect(e017[0]?.nodeId).toBe("work");
    expect(e017[0]?.message).toMatch(/not valid JSON|must be a JSON object/);
  });

  test("rejects non-object output_schema (array)", () => {
    const diags = validate(parseDotSource(nodeWithSchema(`prompt="x", output_schema="[1,2,3]"`)));
    const e017 = diags.find((d) => d.code === "E017");
    expect(e017).toBeDefined();
    expect(e017?.message).toMatch(/must be a JSON object/);
  });

  test("accepts valid Typebox-shaped JSON Schema", () => {
    const schema =
      '{\\"type\\":\\"object\\",\\"properties\\":{\\"label\\":{\\"type\\":\\"string\\"}},\\"required\\":[\\"label\\"]}';
    const diags = validate(parseDotSource(nodeWithSchema(`prompt="x", output_schema="${schema}"`)));
    expect(diags.some((d) => d.code === "E017")).toBe(false);
  });

  test("empty / whitespace output_schema is ignored", () => {
    const diags = validate(parseDotSource(nodeWithSchema(`prompt="x", output_schema=""`)));
    expect(diags.some((d) => d.code === "E017")).toBe(false);
  });

  test("output_schema does not trigger W013 (unrecognised attribute)", () => {
    const schema = '{\\"type\\":\\"object\\"}';
    const diags = validate(parseDotSource(nodeWithSchema(`prompt="x", output_schema="${schema}"`)));
    const w013 = diags.find((d) => d.code === "W013" && d.message.includes("output_schema"));
    expect(w013).toBeUndefined();
  });
});

describe("validateOrThrow", () => {
  test("ok graph does not throw", () => {
    validateOrThrow(
      parseDotSource(`
        digraph {
          s [shape=Mdiamond]
          work
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
  });

  test("missing start throws ValidationError", () => {
    expect(() => validateOrThrow(parseDotSource(`digraph { a; b [shape=Msquare]; a -> b }`))).toThrow(ValidationError);
  });
});
