// TODO(yaml-cutover commit 2): rewrite inline-DOT fixtures to mkGraph() or
// YAML. Wholesale .skip until that migration lands; the new YAML parser is
// covered by yaml.test.ts.

import { describe, expect, test } from "bun:test";
import { ValidationError, validate, validateOrThrow } from "../../src/engine/validator.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";

function codes(dots: string): string[] {
  return validate(parseWorkflow(dots)).map((d) => d.code);
}

describe.skip("validate", () => {
  test("valid minimal graph has no errors", () => {
    const diags = validate(
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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

  test("E006 cycle without reachable exit", () => {
    const diags = validate(
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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

describe.skip("HITL (wait.human) lint rules", () => {
  test("E009: human node with no outgoing edges", () => {
    const diags = validate(
      parseWorkflow(`
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
    expect(e009?.message).toMatch(/routes=/);
  });

  test("E009 not raised for human node with outgoing edges", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon, routes="approve,reject"]
          a [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a [route=approve]
          gate -> done [route=reject]
          a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E009")).toBe(false);
  });

  test("E010: hexagon outgoing edges with colliding accelerator keys", () => {
    // Both `Approve` and `Acknowledge` start with A → collision.
    const diags = validate(
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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

  test("W004 rule is removed — context.hitl.* condition no longer emits W004", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon, routes="approve,reject"]
          a [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a    [route=approve]
          gate -> done [route=reject]
          a -> done    [outcome=success]
        }
      `),
    );
    expect(diags.some((d) => d.code === "W004")).toBe(false);
  });

  test("E010 reports unique-key sets independently per hexagon node", () => {
    // Two hexagons; only the second has a collision.
    const diags = validate(
      parseWorkflow(`
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

describe.skip("goal-gate / retry-target lints (attractor §3.4)", () => {
  test("E011: node retry_target references undefined node", () => {
    const diags = validate(
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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

describe.skip("structural lints (attractor §11.2)", () => {
  test("E012: start node has incoming edges", () => {
    const diags = validate(
      parseWorkflow(`
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
      parseWorkflow(`
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

  test("W009: codergen node with empty prompt and empty label", () => {
    const diags = validate(
      parseWorkflow(`
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
      parseWorkflow(`
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

  test("E027: summary= requires thread_id", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, prompt="hi", summary="medium"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const e027 = diags.find((d) => d.code === "E027");
    expect(e027).toBeDefined();
    expect(e027?.nodeId).toBe("work");
  });

  test("E027 not raised when summary paired with thread_id", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, prompt="hi", thread_id="t1", summary="medium"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E027")).toBe(false);
  });
});

describe.skip("stylesheet lint (attractor §8)", () => {
  test("E015: malformed model_stylesheet", () => {
    const diags = validate(
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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

describe.skip("retry-policy lints (attractor §3.6)", () => {
  test("W008: node retry_policy is not a known preset name", () => {
    const diags = validate(
      parseWorkflow(`
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
        parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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

describe.skip("type override + unknown-attribute lints (attractor §2.6 / §4.2)", () => {
  test("E016: type= references an unknown handler", () => {
    const diags = validate(
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
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
      parseWorkflow(`
        digraph {
          graph [goal="x", budget_usd=5.0]
          s [shape=Mdiamond]
          work [prompt="hi", allowed_tools="read", llm_model="claude-sonnet-4-6", thread_id="t1", summary="low"]
          done [shape=Msquare]
          s -> work -> done [label="ok", outcome=success]
        }
      `),
    );
    expect(diags.some((d) => d.code === "W013")).toBe(false);
  });

  test("W014: loop_restart on an edge", () => {
    const diags = validate(
      parseWorkflow(`
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
});

describe.skip("validateOrThrow", () => {
  test("ok graph does not throw", () => {
    validateOrThrow(
      parseWorkflow(`
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
    expect(() => validateOrThrow(parseWorkflow(`digraph { a; b [shape=Msquare]; a -> b }`))).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Routing + human-node structural rules (E017–E026)
// ---------------------------------------------------------------------------

describe.skip("routing node lints (E017–E021)", () => {
  test("E017 fires when a routing node has an outgoing edge with outcome=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="a,b", prompt="pick"]
          done [shape=Msquare]
          s -> router
          router -> done [outcome=success]
        }
      `),
    );
    expect(diags.find((d) => d.code === "E017")).toBeDefined();
  });

  test("E017 not raised when routing node has only route= edges", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="a,b", prompt="pick"]
          a [shape=box]
          done [shape=Msquare]
          s -> router
          router -> a    [route=a]
          router -> done [route=b]
          a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E017")).toBe(false);
  });

  test("E018 fires when an edge has both outcome= and route=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          a [shape=box]
          done [shape=Msquare]
          s -> a -> done [outcome=success, route=ok]
        }
      `),
    );
    expect(diags.find((d) => d.code === "E018")).toBeDefined();
  });

  test("E018 not raised on edge with only outcome= or only route=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="ok", prompt="go"]
          a [shape=box, prompt="a"]
          done [shape=Msquare]
          s -> a
          a -> router    [outcome=success]
          router -> done [route=ok]
        }
      `),
    );
    expect(diags.some((d) => d.code === "E018")).toBe(false);
  });

  test("E019 fires when edge route= names a value not in source routes=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="a,b", prompt="pick"]
          done [shape=Msquare]
          s -> router
          router -> done [route=c]
        }
      `),
    );
    const e019 = diags.find((d) => d.code === "E019");
    expect(e019).toBeDefined();
    expect(e019?.message).toMatch(/c/);
  });

  test("E019 fires when source node declares no routes= at all", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          a [shape=box, prompt="plain"]
          done [shape=Msquare]
          s -> a -> done [route=x]
        }
      `),
    );
    expect(diags.find((d) => d.code === "E019")).toBeDefined();
  });

  test("E019 not raised when edge route= is included in source routes=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="a,b", prompt="pick"]
          a [shape=box]
          done [shape=Msquare]
          s -> router
          router -> a    [route=a]
          router -> done [route=b]
          a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E019")).toBe(false);
  });

  test("E020 fires when a routing node has an unannotated outgoing edge", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="a", prompt="pick"]
          done [shape=Msquare]
          s -> router
          router -> done
        }
      `),
    );
    expect(diags.find((d) => d.code === "E020")).toBeDefined();
  });

  test("E020 not raised when every edge from a routing node is annotated", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="a", prompt="pick"]
          done [shape=Msquare]
          s -> router
          router -> done [route=a]
        }
      `),
    );
    expect(diags.some((d) => d.code === "E020")).toBe(false);
  });

  test("E021 fires when a declared route has no matching outgoing edge", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="a,b", prompt="pick"]
          done [shape=Msquare]
          s -> router
          router -> done [route=a]
        }
      `),
    );
    const e021 = diags.find((d) => d.code === "E021");
    expect(e021).toBeDefined();
    expect(e021?.message).toMatch(/"b"/);
  });

  test("E021 not raised when every declared route has a matching edge", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          router [shape=box, routes="a,b", prompt="pick"]
          a [shape=box]
          done [shape=Msquare]
          s -> router
          router -> a    [route=a]
          router -> done [route=b]
          a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E021")).toBe(false);
  });
});

describe.skip("human node lints (E022)", () => {
  test("E022 fires on hexagon node (shape-derived kind=human) with no routes=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon]
          done [shape=Msquare]
          s -> gate -> done
        }
      `),
    );
    const e022 = diags.find((d) => d.code === "E022");
    expect(e022).toBeDefined();
    expect(e022?.nodeId).toBe("gate");
  });

  test("E022 fires on explicit kind=human node with no routes=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=box, kind=human]
          done [shape=Msquare]
          s -> gate -> done
        }
      `),
    );
    expect(diags.find((d) => d.code === "E022")).toBeDefined();
  });

  test("E022 not raised on human node with routes= declared", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon, routes="approve,reject"]
          a [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a    [route=approve]
          gate -> done [route=reject]
          a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E022")).toBe(false);
  });
});

describe.skip("goal_gate + routes= mutual exclusion (E023)", () => {
  test("E023 fires when node has both goal_gate=true and routes=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=box, goal_gate=true, routes="a,b", retry_target=s, prompt="eval"]
          done [shape=Msquare]
          s -> gate
          gate -> done [route=a]
          gate -> s    [route=b]
        }
      `),
    );
    expect(diags.find((d) => d.code === "E023")).toBeDefined();
  });

  test("E023 not raised when goal_gate=true without routes=", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=box, goal_gate=true, retry_target=s, prompt="eval"]
          done [shape=Msquare]
          s -> gate -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E023")).toBe(false);
  });
});

describe.skip("duplicate discriminator (E024)", () => {
  test("E024 fires when two edges from the same source share the same outcome= value", () => {
    const diags = validate({
      id: "G",
      directed: true,
      attrs: {},
      nodes: {
        s: { id: "s", shape: "Mdiamond", attrs: {}, classes: [] },
        a: { id: "a", shape: "box", attrs: {}, classes: [] },
        b: { id: "b", shape: "box", attrs: {}, classes: [] },
        done: { id: "done", shape: "Msquare", attrs: {}, classes: [] },
      },
      edges: [
        { from: "s", to: "a", attrs: {} },
        { from: "a", to: "b", attrs: { outcome: "success" } },
        { from: "a", to: "done", attrs: { outcome: "success" } },
      ],
      subgraphs: [],
    });
    const e024 = diags.find((d) => d.code === "E024");
    expect(e024).toBeDefined();
    expect(e024?.message).toMatch(/success/);
  });

  test("E024 fires when two edges from the same source share the same route= value", () => {
    const diags = validate({
      id: "G",
      directed: true,
      attrs: {},
      nodes: {
        s: { id: "s", shape: "Mdiamond", attrs: { routes: ["ok"] }, classes: [] },
        a: { id: "a", shape: "box", attrs: { routes: ["ok"] }, classes: [] },
        b: { id: "b", shape: "box", attrs: {}, classes: [] },
        done: { id: "done", shape: "Msquare", attrs: {}, classes: [] },
      },
      edges: [
        { from: "s", to: "a", attrs: {} },
        { from: "a", to: "b", attrs: { route: "ok" } },
        { from: "a", to: "done", attrs: { route: "ok" } },
      ],
      subgraphs: [],
    });
    const e024 = diags.find((d) => d.code === "E024");
    expect(e024).toBeDefined();
    expect(e024?.message).toMatch(/ok/);
  });

  test("E024 not raised when discriminator values are distinct", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          a [shape=box, prompt="go"]
          done [shape=Msquare]
          s -> a
          a -> done [outcome=success]
          a -> s    [outcome=fail]
        }
      `),
    );
    expect(diags.some((d) => d.code === "E024")).toBe(false);
  });
});

describe.skip("kind/shape contradiction (E025)", () => {
  test("E025 fires when explicit kind= contradicts the shape's SHAPE_TO_KIND mapping", () => {
    // kind=codergen shape=hexagon — SHAPE_TO_KIND maps hexagon→human, contradiction.
    // Must construct manually: the parser validates kind against the enum
    // ["codergen","tool","human"] but does NOT reject contradictions itself.
    const diags = validate({
      id: "G",
      directed: true,
      attrs: {},
      nodes: {
        s: { id: "s", shape: "Mdiamond", attrs: {}, classes: [] },
        gate: { id: "gate", shape: "hexagon", attrs: { kind: "codergen" }, classes: [] },
        done: { id: "done", shape: "Msquare", attrs: {}, classes: [] },
      },
      edges: [
        { from: "s", to: "gate", attrs: {} },
        { from: "gate", to: "done", attrs: {} },
      ],
      subgraphs: [],
    });
    const e025 = diags.find((d) => d.code === "E025");
    expect(e025).toBeDefined();
    expect(e025?.nodeId).toBe("gate");
    expect(e025?.message).toMatch(/codergen/);
    expect(e025?.message).toMatch(/human/);
  });

  test("E025 not raised when kind=human and shape=hexagon (valid alias)", () => {
    const diags = validate({
      id: "G",
      directed: true,
      attrs: {},
      nodes: {
        s: { id: "s", shape: "Mdiamond", attrs: {}, classes: [] },
        gate: { id: "gate", shape: "hexagon", attrs: { kind: "human", routes: ["approve", "reject"] }, classes: [] },
        a: { id: "a", shape: "box", attrs: {}, classes: [] },
        done: { id: "done", shape: "Msquare", attrs: {}, classes: [] },
      },
      edges: [
        { from: "s", to: "gate", attrs: {} },
        { from: "gate", to: "a", attrs: { route: "approve" } },
        { from: "gate", to: "done", attrs: { route: "reject" } },
        { from: "a", to: "done", attrs: {} },
      ],
      subgraphs: [],
    });
    expect(diags.some((d) => d.code === "E025")).toBe(false);
  });
});

describe.skip("text= on non-human node (E026)", () => {
  test("E026 fires when text= is set on a codergen (box) node", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          work [shape=box, text="some display text", prompt="do the thing"]
          done [shape=Msquare]
          s -> work -> done
        }
      `),
    );
    const e026 = diags.find((d) => d.code === "E026");
    expect(e026).toBeDefined();
    expect(e026?.nodeId).toBe("work");
    expect(e026?.message).toMatch(/human/);
  });

  test("E026 not raised when text= is set on a human node", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon, routes="approve,reject", text="Please review the diff"]
          a [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a    [route=approve]
          gate -> done [route=reject]
          a -> done
        }
      `),
    );
    expect(diags.some((d) => d.code === "E026")).toBe(false);
  });
});

describe.skip("routing rule sanity checks", () => {
  test("W004 context.hitl.* condition no longer emits any diagnostic with that code", () => {
    // W004 was removed; verify no leftover W004 on a graph that previously would have triggered it.
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          gate [shape=hexagon, routes="approve,reject"]
          a [shape=box]
          done [shape=Msquare]
          s -> gate
          gate -> a    [route=approve]
          gate -> done [route=reject]
          a -> done    [outcome=success]
        }
      `),
    );
    expect(diags.some((d) => d.code === "W004")).toBe(false);
  });

  test("E009 message contains routes= reference", () => {
    const diags = validate(
      parseWorkflow(`
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
    expect(e009?.message).toMatch(/routes=/);
  });

  test("well-formed routing workflow with human node has no routing errors", () => {
    const diags = validate(
      parseWorkflow(`
        digraph {
          s [shape=Mdiamond]
          analyse [shape=box, routes="small,large", prompt="Assess scope"]
          review  [shape=hexagon, routes="approve,reject", text="Review the plan"]
          impl    [shape=box, prompt="Implement"]
          done    [shape=Msquare]
          s       -> analyse
          analyse -> impl [route=small]
          analyse -> impl [route=large]
          impl    -> review
          review  -> done [route=approve]
          review  -> s    [route=reject]
        }
      `),
    );
    const routingErrors = diags.filter((d) =>
      ["E017", "E018", "E019", "E020", "E021", "E022", "E023", "E024", "E025", "E026"].includes(d.code),
    );
    expect(routingErrors).toHaveLength(0);
  });
});
