import { describe, expect, test } from "bun:test";
import { resolveInputBindings, validateInputBindings } from "../../src/engine/inputs.ts";
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
});
