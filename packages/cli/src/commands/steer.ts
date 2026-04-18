// `swarm steer <run-id> "<message>"` — enqueue a steering message for a
// currently-running swarm process. Writes a `ControlRequest` line to
// `<runsDir>/<run-id>/control.jsonl`; the running executor's control loop
// tails the file, injects the message into the active agent, and emits
// `control.requested` + `control.applied` events on the run's stream.

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { submitControlRequest } from "@swarm/events";
import chalk from "chalk";

export interface SteerCommandOptions {
  runId: string;
  message: string;
  runsDir?: string;
  cwd?: string;
}

export async function steerCommand(opts: SteerCommandOptions): Promise<number> {
  if (!opts.message.trim()) {
    console.error(chalk.red("steer: message is empty"));
    return 1;
  }
  const runsDir = opts.runsDir ?? ".swarm/runs";
  const cwd = opts.cwd ?? process.cwd();
  const runDir = resolve(cwd, runsDir, opts.runId);

  try {
    const s = await stat(runDir);
    if (!s.isDirectory()) {
      console.error(chalk.red(`steer: ${runDir} is not a directory`));
      return 1;
    }
  } catch {
    console.error(
      chalk.red(
        `steer: run "${opts.runId}" not found at ${runDir}. ` +
          "Run `swarm list` to see recent run ids, or check the cwd.",
      ),
    );
    return 1;
  }

  const filePath = resolve(runDir, "control.jsonl");
  const request = await submitControlRequest(filePath, "steer", { message: opts.message });

  console.log(chalk.green(`steer → ${opts.runId}`));
  console.log(chalk.dim(`  file: ${filePath}`));
  console.log(chalk.dim(`  id:   ${request.id}`));
  console.log(chalk.dim(`  msg:  ${opts.message.slice(0, 120)}${opts.message.length > 120 ? "…" : ""}`));
  return 0;
}
