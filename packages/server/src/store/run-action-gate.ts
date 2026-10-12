// Assemble the run-action gate the shared `@fragua/workspace` accept/discard
// consult, from the read plane's control-state slice. The state preconditions
// live inside the workspace action, so the server and the CLI share one set of
// refusals (intent-plane.md §3.7); this only gathers the inputs.
import type { ReadPlane } from "@fragua/core/read-plane";
import { defaultGitExec, type RunActionGate, resolveCheckoutKey } from "@fragua/workspace";

/** The gate for `runId`, or `null` when the run doesn't exist. `checkoutBusy`
 * (accept-only) is the held read on run.cwd's checkout — every accept writes
 * that checkout, so none proceeds while a checkout run holds it. */
export async function buildRunActionGate(
  readPlane: Pick<ReadPlane, "controlState" | "checkoutHeld">,
  runId: string,
  opts: { forAccept: boolean },
): Promise<RunActionGate | null> {
  const state = readPlane.controlState(runId);
  if (state == null) return null;
  let checkoutBusy: RunActionGate["checkoutBusy"] = null;
  if (opts.forAccept && state.cwd != null) {
    const key = await resolveCheckoutKey(defaultGitExec, state.cwd);
    const holder = key != null ? readPlane.checkoutHeld(key) : null;
    if (key != null && holder != null && holder.runId !== runId) {
      checkoutBusy = { runId: holder.runId, status: holder.status, path: key };
    }
  }
  return {
    runId,
    status: state.status,
    inboxStatus: state.inboxStatus,
    cwd: state.cwd,
    baseGitSha: state.baseGitSha ?? "",
    baseHeadSha: state.baseHeadSha,
    diffBaseSha: state.diffBaseSha,
    inCheckout: state.inCheckout,
    checkoutPath: state.checkoutPath,
    checkoutBusy,
  };
}
