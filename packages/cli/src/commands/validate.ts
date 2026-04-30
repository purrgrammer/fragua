// `swarm validate <workflow>` — parse + lint a workflow without executing.
// `<workflow>` resolves the same way `swarm run` does: bare name looks up
// `<cwd>/.swarm/workflows/<name>.dot`, anything pathy is read directly.

import { readFile } from "node:fs/promises";
import { parseDotSource, validate } from "@swarm/core";
import chalk from "chalk";
import { resolveWorkflow } from "../workflow-path.ts";

export async function validateCommand(workflow: string): Promise<number> {
  const cwd = process.cwd();
  const resolved = await resolveWorkflow(cwd, workflow);
  if (resolved == null) {
    console.error(
      chalk.red(
        `validate: workflow not found: ${workflow} (looked in .swarm/workflows/${workflow}.dot, then as a path)`,
      ),
    );
    return 1;
  }
  const source = await readFile(resolved.dotPath, "utf8");
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
