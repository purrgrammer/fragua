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
