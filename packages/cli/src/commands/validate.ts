// `swarm validate <workflow.dot>` — parse + lint a workflow without executing.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDotSource, validate } from "@swarm/core";
import chalk from "chalk";

export async function validateCommand(path: string): Promise<number> {
  const source = await readFile(resolve(path), "utf8");
  const graph = parseDotSource(source);
  const diags = validate(graph);

  if (diags.length === 0) {
    console.log(chalk.green("ok — no diagnostics"));
    return 0;
  }
  let errors = 0;
  for (const d of diags) {
    const color = d.severity === "error" ? chalk.red : d.severity === "warning" ? chalk.yellow : chalk.dim;
    console.log(color(`[${d.code}] ${d.severity}: ${d.message}`));
    if (d.severity === "error") errors++;
  }
  console.log(`\n${diags.length} issue(s), ${errors} error(s)`);
  return errors > 0 ? 1 : 0;
}
