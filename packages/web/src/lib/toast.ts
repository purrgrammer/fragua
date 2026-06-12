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

type SuccessLabel<TData, TVars> = string | ((data: TData, vars: TVars) => string);
type ErrorLabel<TVars> = string | ((err: unknown, vars: TVars) => string);

export interface MutationToastOptions<TData = unknown, TVars = void> {
  /** Toast text on success. Pass a function to interpolate mutation data/vars. */
  success?: SuccessLabel<TData, TVars>;
  /** Toast text on error. Defaults to `extractErrorMessage`. */
  error?: ErrorLabel<TVars>;
}

/**
 * Returns `{ onSuccess, onError }` callbacks ready to spread into a
 * `useMutation({ ... })` call. Any existing `onSuccess` / `onError` in
 * the same mutation can be chained manually:
 *
 *   const m = useMutation({
 *     mutationFn: doSomething,
 *     onSuccess: async (...args) => {
 *       await invalidate();
 *       mutationToast<ResultType>({ success: "Done!" }).onSuccess(...args);
 *     },
 *     ...mutationToast<ResultType, never>({ error: "Failed!" }),
 *   });
 *
 * Or use `withToast` to compose them automatically.
 */
export function mutationToast<TData = unknown, TVars = void>(
  opts: MutationToastOptions<TData, TVars> = {},
): { onSuccess: (data: TData, vars: TVars) => void; onError: (err: unknown, vars: TVars) => void } {
  return {
    onSuccess(data: TData, vars: TVars) {
      if (opts.success == null) return;
      const msg = typeof opts.success === "function" ? opts.success(data, vars) : opts.success;
      toast.success(msg);
    },
    onError(err: unknown, vars: TVars) {
      if (opts.error == null) {
        toastError(err);
        return;
      }
      const msg = typeof opts.error === "function" ? opts.error(err, vars) : opts.error;
      toast.error(msg);
    },
  };
}
