// `swarm cancel <run-id>` — request a graceful cancel of a running pipeline.
//
// Writes a `ControlRequest { command: "cancel" }` line to
// `<runsDir>/<run-id>/control.jsonl`. The executor trips its internal
// AbortController, in-flight handlers unwind via their signal checks,
// and `pipeline.canceled` is emitted as the terminal event. The run
// process exits with a non-zero status because the pipeline did not
// run to completion — callers should consult `pipeline.canceled` in
// the event stream to distinguish canceled from spontaneous failure.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { submitControlRequest } from "@swarm/events";
import chalk from "chalk";

export interface CancelCommandOptions {
  runId: string;
  reason?: string;
  runsDir?: string;
  cwd?: string;
}

export async function cancelCommand(opts: CancelCommandOptions): Promise<number> {
  const runsDir = opts.runsDir ?? ".swarm/runs";
  const cwd = opts.cwd ?? process.cwd();
  const runDir = resolve(cwd, runsDir, opts.runId);

  try {
    const s = await stat(runDir);
    if (!s.isDirectory()) {
      console.error(chalk.red(`cancel: ${runDir} is not a directory`));
      return 1;
    }
  } catch {
    console.error(
      chalk.red(
        `cancel: run "${opts.runId}" not found at ${runDir}. ` +
          "Run `swarm list` to see recent run ids, or check the cwd.",
      ),
    );
    return 1;
  }

  const filePath = resolve(runDir, "control.jsonl");
  const payload = opts.reason ? { reason: opts.reason } : undefined;
  const request = await submitControlRequest(filePath, "cancel", payload);

  console.log(chalk.yellow(`cancel → ${opts.runId}`));
  console.log(chalk.dim(`  file: ${filePath}`));
  console.log(chalk.dim(`  id:   ${request.id}`));
  if (opts.reason) console.log(chalk.dim(`  reason: ${opts.reason}`));
  return 0;
}
