import { describe, expect, test } from "bun:test";
import { OutputsProfileError, parseOutputsDecl, validateOutputsDeclStatic } from "../../src/engine/outputs-profile.ts";
import { canonicalizeOutputsDecl, compileOutputsToTypeBox, validateOutputsValue } from "../../src/types/outputs.ts";

describe("outputs profile parser", () => {
  test("accepts scalars: string/number/boolean/choice", () => {
    const raw = {
      name: { type: "string" },
      count: { type: "number" },
      flag: { type: "boolean" },
      env: { type: "choice", options: ["dev", "staging", "prod"] },
    };
    const decl = parseOutputsDecl(raw);
    expect(decl["name"]).toEqual({ kind: "string" });
    expect(decl["count"]).toEqual({ kind: "number" });
    expect(decl["flag"]).toEqual({ kind: "boolean" });
    expect(decl["env"]).toEqual({ kind: "choice", options: ["dev", "staging", "prod"] });
  });

  test("accepts records with typed fields and required[] sorted", () => {
    const raw = {
      meta: {
        type: "object",
        fields: {
          pr_number: { type: "string" },
          loc: { type: "number" },
        },
      },
    };
    const decl = parseOutputsDecl(raw);
    const rec = decl["meta"]!;
    expect(rec.kind).toBe("record");
    if (rec.kind === "record") {
      expect(Object.keys(rec.fields).sort()).toEqual(["loc", "pr_number"]);
      // default required = all fields sorted
      expect(rec.required).toEqual(["loc", "pr_number"]);
    }
  });

  test("accepts explicit required[] subset", () => {
    const raw = {
      meta: {
        type: "object",
        fields: {
          pr_number: { type: "string" },
          loc: { type: "number" },
        },
        required: ["pr_number"],
      },
    };
    const decl = parseOutputsDecl(raw);
    const rec = decl["meta"]!;
    expect(rec.kind).toBe("record");
    if (rec.kind === "record") {
      expect(rec.required).toEqual(["pr_number"]);
    }
  });

  test("honors per-field `optional: true` (folds into the required split)", () => {
    const decl = parseOutputsDecl({
      finding: {
        type: "object",
        fields: {
          severity: { type: "string" },
          location: { type: "string" },
          fix: { type: "string", optional: true },
        },
      },
    });
    const rec = decl["finding"]!;
    expect(rec.kind).toBe("record");
    if (rec.kind === "record") {
      // `fix` is optional ⇒ absent from required; the other two stay required.
      expect(rec.required).toEqual(["location", "severity"]);
      // the field itself still parses to its declared type
      expect(rec.fields["fix"]).toEqual({ kind: "string" });
    }
  });

  test("rejects a top-level `optional: true` (only valid on a record field)", () => {
    // Every declared top-level output must be emitted; a top-level optional is
    // meaningless and was silently dropped before — now it errors loudly.
    expect(() => parseOutputsDecl({ foo: { type: "string", optional: true } })).toThrow(OutputsProfileError);
    expect(() => parseOutputsDecl({ foo: { type: "string", optional: true } })).toThrow(/top-level output "foo"/);
  });

  test("rejects a field that is both `optional: true` and listed in required", () => {
    const raw = {
      rec: {
        type: "object",
        fields: { a: { type: "string" }, b: { type: "string", optional: true } },
        required: ["a", "b"],
      },
    };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("accepts arrays of scalars", () => {
    const raw = {
      tags: { type: "array", items: { type: "string" } },
    };
    const decl = parseOutputsDecl(raw);
    const arr = decl["tags"]!;
    expect(arr.kind).toBe("array");
    if (arr.kind === "array") {
      expect(arr.items).toEqual({ kind: "string" });
    }
  });

  test("accepts arrays of records", () => {
    const raw = {
      bumps: {
        type: "array",
        items: {
          type: "object",
          fields: {
            pkg: { type: "string" },
            version: { type: "string" },
          },
        },
      },
    };
    const decl = parseOutputsDecl(raw);
    const arr = decl["bumps"]!;
    expect(arr.kind).toBe("array");
    if (arr.kind === "array") {
      expect(arr.items.kind).toBe("record");
    }
  });

  test("accepts kind: syntax (internal style)", () => {
    const raw = { name: { kind: "string" } };
    const decl = parseOutputsDecl(raw);
    expect(decl["name"]).toEqual({ kind: "string" });
  });

  test("accepts enum: shorthand for choice", () => {
    const raw = { env: { enum: ["dev", "prod"] } };
    const decl = parseOutputsDecl(raw);
    expect(decl["env"]).toEqual({ kind: "choice", options: ["dev", "prod"] });
  });

  test("rejects pattern → OutputsProfileError", () => {
    const raw = { name: { type: "string", pattern: "^[a-z]+$" } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
    expect(() => parseOutputsDecl(raw)).toThrow(/disallowed JSON-Schema key "pattern"/);
  });

  test("rejects format → OutputsProfileError", () => {
    const raw = { email: { type: "string", format: "email" } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects minimum/maximum → OutputsProfileError", () => {
    const raw = { n: { type: "number", minimum: 0 } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects oneOf → OutputsProfileError", () => {
    const raw = { x: { oneOf: [{ type: "string" }, { type: "number" }] } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects if/allOf → OutputsProfileError", () => {
    const raw = { x: { type: "string", allOf: [{ type: "string" }] } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects $ref → OutputsProfileError", () => {
    const raw = { x: { $ref: "#/defs/Foo" } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects cosmetic title → OutputsProfileError", () => {
    const raw = { name: { type: "string", title: "The Name" } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects unknown type → OutputsProfileError", () => {
    const raw = { x: { type: "date" } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects a non-string member in choice options (not silently dropped)", () => {
    const raw = { env: { type: "choice", options: ["a", 1, "b"] } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects a non-string member in the enum shorthand", () => {
    const raw = { env: { enum: ["a", true] } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });

  test("rejects required naming a field that isn't declared", () => {
    const raw = { rec: { type: "object", fields: { a: { type: "string" } }, required: ["a", "ghost"] } };
    expect(() => parseOutputsDecl(raw)).toThrow(OutputsProfileError);
  });
});

describe("validateOutputsDeclStatic", () => {
  test("returns E034 for empty declaration", () => {
    const diags = validateOutputsDeclStatic({}, "myNode");
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe("E034");
  });

  test("returns E034 for non-identifier key", () => {
    const decl = parseOutputsDecl({ valid: { type: "string" } });
    // Inject a bad key manually
    const badDecl = { ...decl, "bad-key": { kind: "string" as const } };
    const diags = validateOutputsDeclStatic(badDecl, "myNode");
    expect(diags.some((d) => d.code === "E034" && d.message.includes("bad-key"))).toBe(true);
  });

  test("returns E033 for empty choice options", () => {
    const decl = { env: { kind: "choice" as const, options: [] } };
    const diags = validateOutputsDeclStatic(decl, "myNode");
    expect(diags.some((d) => d.code === "E033")).toBe(true);
  });

  test("passes valid declaration", () => {
    const decl = parseOutputsDecl({ pr_number: { type: "string" }, loc: { type: "number" } });
    const diags = validateOutputsDeclStatic(decl, "myNode");
    expect(diags).toHaveLength(0);
  });
});

describe("canonicalizeOutputsDecl", () => {
  test("sorts keys alphabetically", () => {
    const decl = parseOutputsDecl({
      z: { type: "string" },
      a: { type: "number" },
      m: { type: "boolean" },
    });
    const canonical = canonicalizeOutputsDecl(decl);
    expect(Object.keys(canonical)).toEqual(["a", "m", "z"]);
  });

  test("sorts enum options", () => {
    const decl = parseOutputsDecl({ env: { type: "choice", options: ["prod", "dev", "staging"] } });
    const canonical = canonicalizeOutputsDecl(decl);
    const choice = canonical["env"]!;
    if (choice.kind === "choice") {
      expect(choice.options).toEqual(["dev", "prod", "staging"]);
    } else {
      throw new Error("expected choice");
    }
  });

  test("sorts record fields and required", () => {
    const decl = parseOutputsDecl({
      meta: {
        type: "object",
        fields: { z: { type: "string" }, a: { type: "number" } },
      },
    });
    const canonical = canonicalizeOutputsDecl(decl);
    const rec = canonical["meta"]!;
    if (rec.kind === "record") {
      expect(Object.keys(rec.fields)).toEqual(["a", "z"]);
      expect(rec.required).toEqual(["a", "z"]);
    }
  });
});

describe("compileOutputsToTypeBox", () => {
  test("lowers string to Type.String()", () => {
    const decl = parseOutputsDecl({ name: { type: "string" } });
    const schema = compileOutputsToTypeBox(decl) as unknown as Record<string, unknown>;
    expect(schema["type"]).toBe("object");
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(props["name"]?.["type"]).toBe("string");
  });

  test("lowers choice to enum schema", () => {
    const decl = parseOutputsDecl({ env: { type: "choice", options: ["dev", "prod"] } });
    const schema = compileOutputsToTypeBox(decl) as unknown as Record<string, unknown>;
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    const envProp = props["env"]!;
    expect(envProp["enum"]).toBeDefined();
    expect(envProp["enum"]).toContain("dev");
    expect(envProp["enum"]).toContain("prod");
  });

  test("lowers record to nested object", () => {
    const decl = parseOutputsDecl({
      meta: { type: "object", fields: { pr: { type: "string" } } },
    });
    const schema = compileOutputsToTypeBox(decl) as unknown as Record<string, unknown>;
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(props["meta"]?.["type"]).toBe("object");
  });

  test("lowers array to array schema", () => {
    const decl = parseOutputsDecl({ tags: { type: "array", items: { type: "string" } } });
    const schema = compileOutputsToTypeBox(decl) as unknown as Record<string, unknown>;
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(props["tags"]?.["type"]).toBe("array");
  });

  test("record honors the declared optional/required split (not every field forced required)", () => {
    // b and c are optional (only `a` required). The lowered record schema must
    // mark exactly the declared `required` — TypeBox's `Type.Object` silently
    // discards a `required` *option*, which would force every field instead.
    const decl = parseOutputsDecl({
      rec: {
        type: "object",
        fields: { c: { type: "string" }, a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
      },
    });
    const schema = compileOutputsToTypeBox(decl) as unknown as Record<string, unknown>;
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(props["rec"]?.["required"]).toEqual(["a"]);
  });

  test("an optional record field lowers to a nullable type, kept out of required", () => {
    // `fix` is optional ⇒ absent from `required` AND its type becomes nullable
    // (`anyOf: [string, null]`) so a model may emit an explicit null.
    const decl = parseOutputsDecl({
      rec: {
        type: "object",
        fields: { a: { type: "string" }, fix: { type: "string", optional: true } },
      },
    });
    const schema = compileOutputsToTypeBox(decl) as unknown as Record<string, unknown>;
    const recProps = (schema["properties"] as Record<string, Record<string, unknown>>)["rec"]!;
    expect(recProps["required"]).toEqual(["a"]); // fix omitted
    const fixSchema = (recProps["properties"] as Record<string, Record<string, unknown>>)["fix"]!;
    const anyOf = fixSchema["anyOf"] as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(anyOf)).toBe(true);
    expect(anyOf!.some((m) => m["type"] === "null")).toBe(true); // nullable
    expect(anyOf!.some((m) => m["type"] === "string")).toBe(true);
  });

  test("record required is canonical (sorted), independent of field declaration order", () => {
    // No `required:` → all fields required; the lowered list must be sorted so
    // the schema is canonical (key order can't change the hash).
    const decl = parseOutputsDecl({
      rec: { type: "object", fields: { b: { type: "string" }, a: { type: "string" } } },
    });
    const schema = compileOutputsToTypeBox(decl) as unknown as Record<string, unknown>;
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(props["rec"]?.["required"]).toEqual(["a", "b"]);
  });
});

describe("validateOutputsValue (runtime)", () => {
  test("accepts valid scalar struct", () => {
    const decl = parseOutputsDecl({ name: { type: "string" }, count: { type: "number" } });
    const err = validateOutputsValue(decl, { name: "Alice", count: 42 });
    expect(err).toBeNull();
  });

  test("rejects missing required field", () => {
    const decl = parseOutputsDecl({ name: { type: "string" } });
    const err = validateOutputsValue(decl, { wrong: "value" });
    expect(err).toContain("missing required output field");
  });

  test("rejects an extra top-level field not in the declaration", () => {
    // Matches the lowered schema's `additionalProperties: false` — our backstop
    // for a non-strict provider that doesn't strip undeclared keys.
    const decl = parseOutputsDecl({ a: { type: "string" } });
    expect(validateOutputsValue(decl, { a: "x", extra: "y" })).not.toBeNull();
  });

  test("rejects an extra field inside a nested record", () => {
    const decl = parseOutputsDecl({ rec: { type: "object", fields: { a: { type: "string" } } } });
    expect(validateOutputsValue(decl, { rec: { a: "x", extra: "y" } })).not.toBeNull();
  });

  test("rejects wrong type", () => {
    const decl = parseOutputsDecl({ count: { type: "number" } });
    const err = validateOutputsValue(decl, { count: "not a number" });
    expect(err).toContain("must be a number");
  });

  test("rejects invalid choice value", () => {
    const decl = parseOutputsDecl({ env: { type: "choice", options: ["dev", "prod"] } });
    const err = validateOutputsValue(decl, { env: "staging" });
    expect(err).toContain("not in choices");
  });

  test("rejects non-object top-level value", () => {
    const decl = parseOutputsDecl({ x: { type: "string" } });
    const err = validateOutputsValue(decl, "not an object");
    expect(err).toContain("must be a plain object");
  });

  test("validates record fields", () => {
    const decl = parseOutputsDecl({
      meta: { type: "object", fields: { pr: { type: "string" } } },
    });
    const ok = validateOutputsValue(decl, { meta: { pr: "123" } });
    expect(ok).toBeNull();
    const bad = validateOutputsValue(decl, { meta: { pr: 123 } });
    expect(bad).toContain("must be a string");
  });

  test("validates array items", () => {
    const decl = parseOutputsDecl({ tags: { type: "array", items: { type: "string" } } });
    const ok = validateOutputsValue(decl, { tags: ["a", "b"] });
    expect(ok).toBeNull();
    const bad = validateOutputsValue(decl, { tags: ["a", 2] });
    expect(bad).toContain("must be a string");
  });

  test("an optional field may be omitted, null, or a valid value — required ones may not", () => {
    const decl = parseOutputsDecl({
      finding: {
        type: "object",
        fields: {
          severity: { type: "string" },
          fix: { type: "string", optional: true },
        },
      },
    });
    // omitted optional → ok
    expect(validateOutputsValue(decl, { finding: { severity: "high" } })).toBeNull();
    // explicit null optional → ok (nullable)
    expect(validateOutputsValue(decl, { finding: { severity: "high", fix: null } })).toBeNull();
    // present-and-valid optional → ok
    expect(validateOutputsValue(decl, { finding: { severity: "high", fix: "do x" } })).toBeNull();
    // wrong-typed optional → still rejected
    expect(validateOutputsValue(decl, { finding: { severity: "high", fix: 7 } })).toContain("must be a string");
    // a required field is NOT nullable / omittable
    expect(validateOutputsValue(decl, { finding: { severity: null, fix: "x" } })).not.toBeNull();
    expect(validateOutputsValue(decl, { finding: { fix: "x" } })).toContain("required");
  });
});
