// `swarm replay <events.jsonl>` — print a human-readable summary of a run.

import { readJsonlEvents } from "@swarm/events";
import chalk from "chalk";

export async function replayCommand(path: string): Promise<number> {
  const events = await readJsonlEvents(path);
  if (events.length === 0) {
    console.log(chalk.yellow("no events"));
    return 0;
  }
  let nodes = 0;
  let errors = 0;
  for (const e of events) {
    const color = e.type.startsWith("pipeline.")
      ? chalk.bold
      : e.type.startsWith("node.")
        ? chalk.cyan
        : e.type.startsWith("tool.")
          ? chalk.magenta
          : chalk.dim;
    const nodeTag = e.node_id ? ` [${e.node_id}]` : "";
    console.log(color(`${e.timestamp} ${e.type}${nodeTag}`));
    if (e.type === "node.started") nodes++;
    if (e.type === "pipeline.failed" || e.type === "node.failed") errors++;
  }
  console.log(chalk.dim(`\n${events.length} events across ${nodes} nodes, ${errors} error(s)`));
  return errors > 0 ? 1 : 0;
}
