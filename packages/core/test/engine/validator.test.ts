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
