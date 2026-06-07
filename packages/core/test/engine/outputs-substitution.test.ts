import { describe, expect, test } from "bun:test";
import { outputReferences, substituteOutputs, UnpopulatedOutputError } from "../../src/engine/outputs-substitution.ts";
import { substitute, wrapOutputValue } from "../../src/engine/substitution.ts";

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

  test("record interpolates as canonical JSON (keys sorted, not emission order)", () => {
    const result = substituteOutputs("data=${{ outputs.scope.meta }}", {
      scope: { meta: { pr: "123", loc: 42 } },
    });
    expect(result).toBe('data={"loc":42,"pr":"123"}');
  });

  test("canonical JSON is stable across key-emission order; array order is preserved", () => {
    const a = substituteOutputs("${{ outputs.s.m }}", { s: { m: { b: 1, a: 2, c: 3 } } });
    const b = substituteOutputs("${{ outputs.s.m }}", { s: { m: { c: 3, a: 2, b: 1 } } });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
    // nested records sort recursively; array element order stays semantic
    expect(substituteOutputs("${{ outputs.s.m }}", { s: { m: { z: { y: 1, x: 2 } } } })).toBe('{"z":{"x":2,"y":1}}');
    expect(substituteOutputs("${{ outputs.s.t }}", { s: { t: ["b", "a", "c"] } })).toBe('["b","a","c"]');
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

  test("a null leaf (optional field emitted as null) fails closed, not literal 'null'", () => {
    expect(() => substituteOutputs("fix=${{ outputs.lens.fix }}", { lens: { fix: null } })).toThrow(
      UnpopulatedOutputError,
    );
    // a falsy-but-present scalar still renders (only "no value" fails closed)
    expect(substituteOutputs("n=${{ outputs.s.n }} b=${{ outputs.s.b }}", { s: { n: 0, b: false } })).toBe(
      "n=0 b=false",
    );
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

describe("substitute() — wrapOutputs (prompt-consumption delimiting)", () => {
  test("wraps an interpolated output value in a content-derived fragua_output tag (well-formed pair)", () => {
    const result = substitute("findings: ${{ outputs.scope.note }}", {
      args: { outputs: { scope: { note: "all good" } } },
      wrapOutputs: true,
    });
    // The hash lives in the element NAME so the open/close pair is well-formed
    // markup (a markdown renderer hides the tags instead of printing a broken
    // `</tag attr="…">`). No surrounding whitespace around the value.
    expect(result).toMatch(/^findings: <fragua_output_([0-9a-f]{64})>all good<\/fragua_output_\1>$/);
  });

  test("the boundary id is content-derived (deterministic; differs by value)", () => {
    expect(wrapOutputValue("abc")).toBe(wrapOutputValue("abc"));
    const idOf = (v: string) => wrapOutputValue(v).match(/<fragua_output_([0-9a-f]+)>/)![1];
    expect(idOf("abc")).not.toBe(idOf("abd"));
  });

  test("boundary id is a 64-hex SHA-256 (browser-safe noble-hashes, no injection)", () => {
    // One cross-env hash everywhere — core hashes with noble-hashes SHA-256, byte
    // -identical to `node:crypto`, so no server-side injection seam is needed.
    const wrapped = substitute("x ${{ outputs.n.v }}", { args: { outputs: { n: { v: "VV" } } }, wrapOutputs: true });
    expect(wrapped).toMatch(/^x <fragua_output_([0-9a-f]{64})>VV<\/fragua_output_\1>$/);
    // SHA-256("VV") — pinned so a hash-impl swap is a visible test break.
    expect(wrapOutputValue("VV")).toBe(
      "<fragua_output_12fe9d97b944ffcda622a39abd67ef89d33b2ea20535254f475f37249969fb91>" +
        "VV</fragua_output_12fe9d97b944ffcda622a39abd67ef89d33b2ea20535254f475f37249969fb91>",
    );
  });

  test("the closing tag carries the same hash as the open (break-out needs a preimage)", () => {
    const wrapped = wrapOutputValue("origin/main..HEAD");
    const m = wrapped.match(/^<fragua_output_([0-9a-f]{64})>(.*)<\/fragua_output_([0-9a-f]{64})>$/s);
    if (m === null) throw new Error(`wrapped value did not match the expected tag shape: ${wrapped}`);
    const openHash = m[1]!;
    const value = m[2]!;
    const closeHash = m[3]!;
    expect(openHash).toBe(closeHash); // break-out would need a value containing its own hash
    expect(value).toBe("origin/main..HEAD"); // value verbatim, no padding whitespace
  });

  test("inputs are NOT wrapped — only outputs", () => {
    const result = substitute("x ${{ inputs.t }} y ${{ outputs.n.v }}", {
      args: { inputs: { t: "TT" }, outputs: { n: { v: "VV" } } },
      wrapOutputs: true,
    });
    expect(result).toContain("x TT y ");
    expect(result).toContain("<fragua_output_"); // the output got wrapped
    expect(result).not.toMatch(/<fragua_output_[0-9a-f]+>TT/); // input stayed bare
    expect(result).toMatch(/<fragua_output_[0-9a-f]+>VV<\/fragua_output_[0-9a-f]+>/);
  });

  test("wrapOutputs is ignored under escapeForShell (shell context, not prompt)", () => {
    const result = substitute("echo ${{ outputs.n.v }}", {
      args: { outputs: { n: { v: "hi" } } },
      wrapOutputs: true,
      escapeForShell: true,
    });
    expect(result).toBe("echo 'hi'");
    expect(result).not.toContain("fragua_output");
  });
});
