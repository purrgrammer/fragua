import { describe, expect, test } from "bun:test";
import { outputReferences, substituteOutputs, UnpopulatedOutputError } from "../../src/engine/outputs-substitution.ts";
import { substitute } from "../../src/engine/substitution.ts";

describe("substituteOutputs", () => {
  test("scalar string leaf interpolates as its value", () => {
    const result = substituteOutputs("merge ${{ outputs.scope.pr_number }}", {
      scope: { pr_number: "123" },
    });
    expect(result).toBe("merge 123");
  });

  test("scalar number leaf interpolates as string", () => {
    const result = substituteOutputs("loc=${{ outputs.scope.loc }}", {
      scope: { loc: 42 },
    });
    expect(result).toBe("loc=42");
  });

  test("scalar boolean leaf interpolates as string", () => {
    const result = substituteOutputs("flag=${{ outputs.n.flag }}", {
      n: { flag: true },
    });
    expect(result).toBe("flag=true");
  });

  test("record interpolates as JSON", () => {
    const result = substituteOutputs("data=${{ outputs.scope.meta }}", {
      scope: { meta: { pr: "123", loc: 42 } },
    });
    expect(result).toBe('data={"pr":"123","loc":42}');
  });

  test("array interpolates as JSON", () => {
    const result = substituteOutputs("tags=${{ outputs.n.tags }}", {
      n: { tags: ["a", "b"] },
    });
    expect(result).toBe('tags=["a","b"]');
  });

  test("dotted leaf reaches inner scalar", () => {
    const result = substituteOutputs("pkg=${{ outputs.update.meta.pkg }}", {
      update: { meta: { pkg: "lodash", version: "4.0.0" } },
    });
    expect(result).toBe("pkg=lodash");
  });

  test("unresolved reference fails closed (throws UnpopulatedOutputError)", () => {
    expect(() => substituteOutputs("x=${{ outputs.nonexistent.field }}", {})).toThrow(UnpopulatedOutputError);
  });

  test("partially-resolved template still throws on the missing ref", () => {
    expect(() => substituteOutputs("a=${{ outputs.s.a }} b=${{ outputs.s.b }}", { s: { a: "1" } })).toThrow(
      /outputs\.s\.b/,
    );
  });

  test("escapeForShell wraps scalar in POSIX single quotes", () => {
    const result = substituteOutputs(
      "run: ${{ outputs.scope.cmd }}",
      { scope: { cmd: "my command" } },
      { escapeForShell: true },
    );
    expect(result).toBe("run: 'my command'");
  });

  test("escapeForShell handles single quotes in value", () => {
    const result = substituteOutputs("x=${{ outputs.n.val }}", { n: { val: "it's here" } }, { escapeForShell: true });
    expect(result).toBe("x='it'\\''s here'");
  });

  test("multiple references resolved in one pass", () => {
    const result = substituteOutputs("gh pr merge ${{ outputs.scope.pr_number }} --title ${{ outputs.scope.title }}", {
      scope: { pr_number: "42", title: "fix" },
    });
    expect(result).toBe("gh pr merge 42 --title fix");
  });

  test("references to different producers", () => {
    const result = substituteOutputs("a=${{ outputs.p1.x }} b=${{ outputs.p2.y }}", {
      p1: { x: "hello" },
      p2: { y: "world" },
    });
    expect(result).toBe("a=hello b=world");
  });
});

describe("outputReferences()", () => {
  test("enumerates distinct producer.path pairs", () => {
    const refs = outputReferences(
      "merge ${{ outputs.scope.pr_number }} loc=${{ outputs.scope.loc }} cmd=${{ outputs.other.cmd }}",
    );
    expect(refs).toHaveLength(3);
    const producers = refs.map((r) => r.producer);
    expect(producers.filter((p) => p === "scope")).toHaveLength(2);
    expect(producers.filter((p) => p === "other")).toHaveLength(1);
  });

  test("deduplicates identical refs", () => {
    const refs = outputReferences("${{ outputs.p.x }} and ${{ outputs.p.x }}");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.producer).toBe("p");
    expect(refs[0]!.path).toEqual(["x"]);
  });

  test("returns empty array for template with no output refs", () => {
    const refs = outputReferences("just text ${{ inputs.x }}");
    expect(refs).toHaveLength(0);
  });

  test("handles dotted paths correctly", () => {
    const refs = outputReferences("${{ outputs.update.meta.pkg }}");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.producer).toBe("update");
    expect(refs[0]!.path).toEqual(["meta", "pkg"]);
  });
});

describe("substitute() integration with outputs", () => {
  test("resolves both inputs and outputs in same template", () => {
    const result = substitute("ticket=${{ inputs.ticket }} pr=${{ outputs.scope.pr_number }}", {
      args: {
        inputs: { ticket: "BUG-1" },
        outputs: { scope: { pr_number: "99" } },
      },
    });
    expect(result).toBe("ticket=BUG-1 pr=99");
  });

  test("no outputs in args → outputs ref fails closed", () => {
    expect(() => substitute("pr=${{ outputs.scope.pr_number }}", { args: { inputs: {} } })).toThrow(
      UnpopulatedOutputError,
    );
  });

  test("escapeForShell applies to both inputs and outputs", () => {
    const result = substitute("run ${{ inputs.cmd }} out=${{ outputs.n.val }}", {
      args: { inputs: { cmd: "my cmd" }, outputs: { n: { val: "it's here" } } },
      escapeForShell: true,
    });
    expect(result).toBe("run 'my cmd' out='it'\\''s here'");
  });
});
