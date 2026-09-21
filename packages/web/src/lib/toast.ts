import { toast } from "sonner";
import { ApiError } from "./api.ts";

export { toast };

/**
 * Extract a human-readable message from an unknown error value.
 * For `ApiError` the server's refusal (`body.error`) leads when present,
 * with the wire context (method, path, status — the `ApiError.message`
 * built by the fetch layer) appended so an operator can report what
 * actually failed. Falls back to `.message`, then `String(err)`.
 */
export function extractErrorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof ApiError) return err.body?.error ? `${err.body.error} (${err.message})` : err.message;
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return fallback;
}

/** Fire a `toast.error` with a consistent ApiError-aware message. */
export function toastError(err: unknown, fallback?: string): void {
  toast.error(extractErrorMessage(err, fallback));
}
