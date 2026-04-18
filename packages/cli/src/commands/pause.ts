// `swarm pause <run-id>` — request a soft pause on a running pipeline.
//
// Writes a `ControlRequest { command: "pause" }` line to
// `<runsDir>/<run-id>/control.jsonl`. The running executor's control
// loop picks it up immediately, emits `control.requested`, and gates
// the scheduler at the next node boundary — the currently-running
// node completes first. `control.applied` lands when pause has
// actually taken effect.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { submitControlRequest } from "@swarm/events";
import chalk from "chalk";

export interface PauseCommandOptions {
  runId: string;
  reason?: string;
  runsDir?: string;
  cwd?: string;
}

export async function pauseCommand(opts: PauseCommandOptions): Promise<number> {
  const runsDir = opts.runsDir ?? ".swarm/runs";
  const cwd = opts.cwd ?? process.cwd();
  const runDir = resolve(cwd, runsDir, opts.runId);

  try {
    const s = await stat(runDir);
    if (!s.isDirectory()) {
      console.error(chalk.red(`pause: ${runDir} is not a directory`));
      return 1;
    }
  } catch {
    console.error(
      chalk.red(
        `pause: run "${opts.runId}" not found at ${runDir}. ` +
          "Run `swarm list` to see recent run ids, or check the cwd.",
      ),
    );
    return 1;
  }

  const filePath = resolve(runDir, "control.jsonl");
  const payload = opts.reason ? { reason: opts.reason } : undefined;
  const request = await submitControlRequest(filePath, "pause", payload);

  console.log(chalk.green(`pause → ${opts.runId}`));
  console.log(chalk.dim(`  file: ${filePath}`));
  console.log(chalk.dim(`  id:   ${request.id}`));
  console.log(chalk.dim("  note: the run finishes its current node before pausing."));
  return 0;
}
