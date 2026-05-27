import { beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "./api.ts";
import { extractErrorMessage, mutationToast } from "./toast.ts";

const { successSpy, errorSpy } = vi.hoisted(() => ({
  successSpy: vi.fn(() => undefined),
  errorSpy: vi.fn(() => undefined),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(
    vi.fn(() => undefined),
    {
      success: successSpy,
      error: errorSpy,
    },
  ),
}));

beforeEach(() => {
  successSpy.mockReset();
  errorSpy.mockReset();
});

describe("extractErrorMessage", () => {
  test("unwraps ApiError.body.error", () => {
    const err = new ApiError("HTTP 409", 409, "/api/foo", { error: "merge conflict detected" });
    expect(extractErrorMessage(err)).toBe("merge conflict detected");
  });

  test("falls back to ApiError.message when body.error is absent", () => {
    const err = new ApiError("HTTP 500", 500, "/api/foo");
    expect(extractErrorMessage(err)).toBe("HTTP 500");
  });

  test("returns Error.message for plain errors", () => {
    expect(extractErrorMessage(new Error("plain error"))).toBe("plain error");
  });

  test("returns fallback for non-Error values", () => {
    expect(extractErrorMessage(null, "fallback text")).toBe("fallback text");
  });
});

describe("mutationToast", () => {
  test("onSuccess calls toast.success with a static string", () => {
    const { onSuccess } = mutationToast({ success: "Run paused" });
    onSuccess(undefined, undefined);
    expect(successSpy).toHaveBeenCalledWith("Run paused");
  });

  test("onSuccess accepts a (data) => string formatter and interpolates data", () => {
    const { onSuccess } = mutationToast<{ id: number }>({
      success: (d) => `ok ${d.id}`,
    });
    onSuccess({ id: 7 }, undefined);
    expect(successSpy).toHaveBeenCalledWith("ok 7");
  });

  test("onSuccess does nothing when success option is omitted", () => {
    const { onSuccess } = mutationToast({});
    onSuccess(undefined, undefined);
    expect(successSpy).not.toHaveBeenCalled();
  });

  test("onError calls toast.error with ApiError.body.error", () => {
    const { onError } = mutationToast({});
    const err = new ApiError("HTTP 409", 409, "/api/foo", { error: "boom" });
    onError(err, undefined);
    expect(errorSpy).toHaveBeenCalledWith("boom");
  });

  test("onError uses static error string override when provided", () => {
    const { onError } = mutationToast({ error: "Custom error message" });
    onError(new Error("ignored"), undefined);
    expect(errorSpy).toHaveBeenCalledWith("Custom error message");
  });

  test("onError accepts an (err, vars) => string formatter", () => {
    const { onError } = mutationToast<unknown, { name: string }>({
      error: (e, v) => `${v.name}: ${extractErrorMessage(e)}`,
    });
    onError(new Error("oops"), { name: "openai" });
    expect(errorSpy).toHaveBeenCalledWith("openai: oops");
  });
});
