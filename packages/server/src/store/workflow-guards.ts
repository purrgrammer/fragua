import { InvalidDurationError, parseDurationMs, type parseWorkflow } from "@fragua/core";
import { ImportedRunError } from "@fragua/store";
import type { Context } from "hono";

/**
 * Scan a workflow source for nodes with malformed `timeout=` or `max_ms=`
 * attrs. Returns the first offender so the API can reject before a
 * workflow is saved (and therefore before any run is enqueued against
 * a broken sha). Returns `null` when every timeout attr parses or
 * nothing is set.
 */
export function findInvalidTimeoutAttr(
  graph: ReturnType<typeof parseWorkflow>,
): { nodeId: string; attr: "timeout" | "max_ms"; value: unknown; detail: string } | null {
  for (const node of Object.values(graph.nodes)) {
    const { timeout, max_ms } = node.attrs;
    if (typeof max_ms === "number") {
      try {
        parseDurationMs(max_ms);
      } catch (err) {
        return {
          nodeId: node.id,
          attr: "max_ms",
          value: max_ms,
          detail: err instanceof InvalidDurationError ? err.message : String(err),
        };
      }
    } else if (max_ms != null) {
      return {
        nodeId: node.id,
        attr: "max_ms",
        value: max_ms,
        detail: "max_ms must be a non-negative integer (ms); 0 disables the wall-clock watchdog",
      };
    }
    if (typeof timeout === "string") {
      try {
        parseDurationMs(timeout);
      } catch (err) {
        return {
          nodeId: node.id,
          attr: "timeout",
          value: timeout,
          detail: err instanceof InvalidDurationError ? err.message : String(err),
        };
      }
    }
  }
  return null;
}

export function invalidWorkflowResponse(c: Context, err: unknown): Response {
  const detail = err instanceof Error ? err.message : String(err);
  return c.json(
    {
      error: `invalid workflow: ${detail}`,
      code: "invalid_workflow",
      detail,
    },
    400,
  );
}

export function importedRunResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof ImportedRunError)) return null;
  return c.json({ error: err.message, code: "imported_run" }, 409);
}
