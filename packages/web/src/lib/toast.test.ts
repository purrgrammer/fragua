import { describe, expect, test } from "vitest";
import { ApiError } from "./api.ts";
import { extractErrorMessage } from "./toast.ts";

describe("extractErrorMessage", () => {
  test("leads with ApiError.body.error and appends the wire context (method, path, status)", () => {
    const err = new ApiError("POST /api/foo → 409 Conflict", 409, "/api/foo", { error: "merge conflict detected" });
    expect(extractErrorMessage(err)).toBe("merge conflict detected (POST /api/foo → 409 Conflict)");
  });

  test("falls back to ApiError.message when body.error is absent", () => {
    const err = new ApiError("GET /api/foo → 500 Internal Server Error", 500, "/api/foo");
    expect(extractErrorMessage(err)).toBe("GET /api/foo → 500 Internal Server Error");
  });

  test("returns Error.message for plain errors", () => {
    expect(extractErrorMessage(new Error("plain error"))).toBe("plain error");
  });

  test("returns fallback for non-Error values", () => {
    expect(extractErrorMessage(null, "fallback text")).toBe("fallback text");
  });
});
