import { describe, expect, test } from "bun:test";
import { coerceInputBindings, resolveInputBindings, validateInputBindings } from "../../src/engine/inputs.ts";
import type { InputDecl } from "../../src/types/graph.ts";

const decl = (over: Partial<InputDecl> & { name: string }): InputDecl => ({
  type: "string",
  required: false,
  ...over,
});

describe("resolveInputBindings", () => {
  test("declared defaults are applied", () => {
    const decls = [decl({ name: "env", default: "dev" }), decl({ name: "verbose", type: "boolean", default: false })];
    expect(resolveInputBindings(decls, {})).toEqual({ env: "dev", verbose: "false" });
  });

  test("provided values override defaults", () => {
    const decls = [decl({ name: "env", default: "dev" })];
    expect(resolveInputBindings(decls, { env: "prod" })).toEqual({ env: "prod" });
  });

  test("inputs without a default and without a value are absent", () => {
    const decls = [decl({ name: "ticket", required: true })];
    expect(resolveInputBindings(decls, {})).toEqual({});
    expect(resolveInputBindings(decls, { ticket: "BUG-1" })).toEqual({ ticket: "BUG-1" });
  });

  test("no decls → empty map", () => {
    expect(resolveInputBindings(undefined, { stray: "x" })).toEqual({});
  });

  test("a structured default passes through un-stringified (not String(d.default))", () => {
    const decls = [
      decl({
        name: "config",
        type: "object",
        profile: { kind: "record", fields: { env: { kind: "string" } }, required: ["env"] },
        default: { env: "dev" } as unknown as string,
      }),
    ];
    expect(resolveInputBindings(decls, {})["config"]).toEqual({ env: "dev" });
  });

  test("object/array values pass through un-stringified; scalars stay coerced", () => {
    const decls = [
      decl({
        name: "config",
        type: "object",
        profile: { kind: "record", fields: { env: { kind: "string" } }, required: ["env"] },
      }),
      decl({ name: "tags", type: "array", profile: { kind: "array", items: { kind: "string" } } }),
      decl({ name: "count", type: "number" }),
    ];
    const resolved = resolveInputBindings(decls, { config: { env: "dev" }, tags: ["a", "b"], count: 5 });
    expect(resolved["config"]).toEqual({ env: "dev" });
    expect(resolved["tags"]).toEqual(["a", "b"]);
    expect(resolved["count"]).toBe("5");
  });
});

describe("validateInputBindings", () => {
  test("required input without value or default → missing_required", () => {
    const errs = validateInputBindings([decl({ name: "ticket", required: true })], {});
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe("missing_required");
    expect(errs[0]?.name).toBe("ticket");
  });

  test("required input with a default → ok when omitted", () => {
    expect(validateInputBindings([decl({ name: "env", required: true, default: "dev" })], {})).toEqual([]);
  });

  test("required input satisfied by a provided value → ok", () => {
    expect(validateInputBindings([decl({ name: "ticket", required: true })], { ticket: "BUG-1" })).toEqual([]);
  });

  test("choice value not in options → invalid_choice", () => {
    const decls = [decl({ name: "env", type: "choice", options: ["dev", "prod"] })];
    const errs = validateInputBindings(decls, { env: "staging" });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe("invalid_choice");
  });

  test("valid choice value → ok", () => {
    const decls = [decl({ name: "env", type: "choice", options: ["dev", "prod"] })];
    expect(validateInputBindings(decls, { env: "prod" })).toEqual([]);
  });

  test("provided key with no declaration → unknown_input", () => {
    const errs = validateInputBindings([decl({ name: "env" })], { env: "x", typo: "y" });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe("unknown_input");
    expect(errs[0]?.name).toBe("typo");
  });

  test("no decls + no provided → ok", () => {
    expect(validateInputBindings(undefined, {})).toEqual([]);
  });

  test("a non-scalar value for a scalar input → invalid_shape", () => {
    const errs = validateInputBindings([decl({ name: "name", type: "string" })], {
      name: { nested: true } as unknown as string,
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe("invalid_shape");
    expect(errs[0]?.name).toBe("name");
  });

  test("a number input handed a string → invalid_shape", () => {
    const errs = validateInputBindings([decl({ name: "n", type: "number" })], { n: "7" as unknown as number });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe("invalid_shape");
  });

  test("null for a required input is treated as not-provided → missing_required", () => {
    const errs = validateInputBindings([decl({ name: "ticket", required: true })], {
      ticket: null as unknown as string,
    });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe("missing_required");
  });

  test("object input value matching its profile → ok", () => {
    const decls = [
      decl({
        name: "config",
        type: "object",
        profile: { kind: "record", fields: { env: { kind: "choice", options: ["dev", "prod"] } }, required: ["env"] },
      }),
    ];
    expect(validateInputBindings(decls, { config: { env: "prod" } })).toEqual([]);
  });

  test("object input value violating its profile → invalid_shape", () => {
    const decls = [
      decl({
        name: "config",
        type: "object",
        profile: { kind: "record", fields: { env: { kind: "choice", options: ["dev", "prod"] } }, required: ["env"] },
      }),
    ];
    const errs = validateInputBindings(decls, { config: { env: "staging" } });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.code).toBe("invalid_shape");
    expect(errs[0]?.name).toBe("config");
  });
});

// Direct unit coverage for `coerceInputBindings` — the sole type-coercion seam
// shared by the CLI and the HTTP server. Reaches it without routing through
// `buildEnqueue` so the boolean gate, the decimal-number grammar, the
// JSON-parse branch, pass-through behaviour, and the reserved-name guards are
// each pinned independently.
describe("coerceInputBindings", () => {
  test("coerces a string to a declared number", () => {
    const { values, errors } = coerceInputBindings([decl({ name: "n", type: "number" })], { n: "3.5" });
    expect(errors).toHaveLength(0);
    expect(values["n"]).toBe(3.5);
  });

  test("rejects blank, hex, and Infinity numbers (original retained in values)", () => {
    for (const bad of ["", "0x10", "Infinity"]) {
      const { values, errors } = coerceInputBindings([decl({ name: "n", type: "number" })], { n: bad });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.code).toBe("invalid_shape");
      expect(values["n"]).toBe(bad);
    }
  });

  test("coerces and rejects booleans", () => {
    const ok = coerceInputBindings([decl({ name: "b", type: "boolean" })], { b: "true" });
    expect(ok.errors).toHaveLength(0);
    expect(ok.values["b"]).toBe(true);

    const off = coerceInputBindings([decl({ name: "b", type: "boolean" })], { b: "false" });
    expect(off.values["b"]).toBe(false);

    const bad = coerceInputBindings([decl({ name: "b", type: "boolean" })], { b: "yes" });
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]!.code).toBe("invalid_shape");
    expect(bad.values["b"]).toBe("yes");
  });

  test("parses object/array inputs via JSON and rejects malformed input", () => {
    const objDecl = decl({
      name: "cfg",
      type: "object",
      profile: { kind: "record", fields: { a: { kind: "number" } }, required: [] },
    });
    const ok = coerceInputBindings([objDecl], { cfg: '{"a":1}' });
    expect(ok.errors).toHaveLength(0);
    expect(ok.values["cfg"]).toEqual({ a: 1 });

    const arrDecl = decl({ name: "xs", type: "array", profile: { kind: "array", items: { kind: "string" } } });
    const arrOk = coerceInputBindings([arrDecl], { xs: '["a","b"]' });
    expect(arrOk.values["xs"]).toEqual(["a", "b"]);

    const bad = coerceInputBindings([objDecl], { cfg: "{not json" });
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]!.code).toBe("invalid_shape");
    expect(bad.values["cfg"]).toBe("{not json");
  });

  test("passes a non-string value through untouched (no double-coercion)", () => {
    const { values, errors } = coerceInputBindings([decl({ name: "n", type: "number" })], { n: 42 });
    expect(errors).toHaveLength(0);
    expect(values["n"]).toBe(42);
  });

  test("passes an undeclared key through for the validator to reject", () => {
    const { values, errors } = coerceInputBindings([decl({ name: "known", type: "string" })], { surprise: "x" });
    expect(errors).toHaveLength(0);
    expect(values["surprise"]).toBe("x");
  });

  test("round-trips an input named 'constructor' without reading a built-in", () => {
    const { values, errors } = coerceInputBindings([decl({ name: "constructor", type: "string" })], {
      constructor: "x",
    });
    expect(errors).toHaveLength(0);
    expect(values["constructor"]).toBe("x");
    expect(typeof values["constructor"]).toBe("string");
  });

  test("skips a __proto__ key without polluting the prototype", () => {
    const { values } = coerceInputBindings([], { ["__proto__"]: { polluted: true } } as Record<string, unknown>);
    expect(Object.hasOwn(values, "__proto__")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
