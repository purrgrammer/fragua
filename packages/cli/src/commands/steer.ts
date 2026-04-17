// `swarm steer <run-id> "<message>"` — enqueue a steering message for a
// currently-running swarm process. The running backend tails the file and
// injects each new line into the active agent via agent.steer().

import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

  const filePath = resolve(runDir, "steering.jsonl");
  await mkdir(dirname(filePath), { recursive: true });

  const entry = JSON.stringify({ timestamp: new Date().toISOString(), message: opts.message });
  await appendFile(filePath, `${entry}\n`, "utf8");

  console.log(chalk.green(`steer → ${opts.runId}`));
  console.log(chalk.dim(`  file: ${filePath}`));
  console.log(chalk.dim(`  msg:  ${opts.message.slice(0, 120)}${opts.message.length > 120 ? "…" : ""}`));
  console.log(chalk.dim("  note: the running swarm picks this up on its next poll (≤500ms by default)."));
  return 0;
}
