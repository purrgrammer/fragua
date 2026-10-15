// `fragua runs release <id>` — free a terminal checkout run's hold on its
// checkout, so the next `--checkout` run (or an accept / `--dirty` into it) can
// proceed. Synchronous: the intent plane refuses `not_checkout_run`,
// `not_terminal`, `already_released`, then commits `intent.checkout_release`
// together with its `fact.checkout_released` in one store transaction.

import { ConcurrencyError, ImportedRunError } from "@fragua/store";
import chalk from "chalk";
import { withStoreClient } from "../store-client.ts";

export interface ReleaseOptions {
  runId: string;
  cwd?: string;
  dbPath?: string;
}

export function releaseCommand(opts: ReleaseOptions): Promise<number> {
  return withStoreClient(opts, ({ store, plane }) => {
    const state = store.getState(opts.runId);
    if (state == null) {
      console.error(chalk.red("release: run not found") + chalk.dim(` (${opts.runId})`));
      return 1;
    }
    const built = plane.buildCheckoutRelease(state);
    if (!built.ok) {
      console.error(chalk.red(`release: ${built.error}`) + chalk.dim(` [${built.code}]`));
      return 1;
    }
    try {
      const { seq } = plane.commitCheckoutRelease(opts.runId, built, state.version);
      console.log(
        chalk.green(`released checkout ${state.checkoutPath ?? "(unbound)"}`) +
          chalk.dim(` (run ${opts.runId}, intent seq ${seq})`),
      );
      if (state.status === "completed") {
        console.log(
          chalk.yellow(
            "release: if this run only just completed, its terminal snapshot may still be recording — " +
              "the checkout is free now, and a snapshot that lands after this release is not waited for",
          ),
        );
      }
      return 0;
    } catch (err) {
      if (err instanceof ImportedRunError) {
        console.error(chalk.red(`release: ${err.message}`));
        return 1;
      }
      if (err instanceof ConcurrencyError) {
        console.error(chalk.red("release: the run changed while releasing; retry"));
        return 1;
      }
      throw err;
    }
  });
}
