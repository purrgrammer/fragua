// `swarm validate <workflow>` — parse + lint a workflow without executing.
// `<workflow>` resolves the same way `swarm run` does: bare name looks up
// `<cwd>/.swarm/workflows/<name>.yaml`, anything pathy is read directly.

import { readFile } from "node:fs/promises";
import { validateWorkflowModels } from "@swarm/agent";
import { parseWorkflow, validate } from "@swarm/core";
import chalk from "chalk";
import { resolveWorkflow } from "../workflow-path.ts";

export async function validateCommand(workflow: string): Promise<number> {
  const cwd = process.cwd();
  const resolved = await resolveWorkflow(cwd, workflow);
  if (resolved == null) {
    console.error(
      chalk.red(
        `validate: workflow not found: ${workflow} (looked in .swarm/workflows/${workflow}.yaml, then as a path)`,
      ),
    );
    return 1;
  }
  const source = await readFile(resolved.dotPath, "utf8");
  const graph = parseWorkflow(source);
  const diags = validate(graph);
  const modelCheck = validateWorkflowModels(source);

  const modelErrorCount = modelCheck.ok ? 0 : modelCheck.offenders.length;
  if (diags.length === 0 && modelErrorCount === 0) {
    console.log(chalk.green("ok — no diagnostics"));
    return 0;
  }
  let errors = 0;
  for (const d of diags) {
    const color = d.severity === "error" ? chalk.red : d.severity === "warning" ? chalk.yellow : chalk.dim;
    console.log(color(`[${d.code}] ${d.severity}: ${d.message}`));
    if (d.severity === "error") errors++;
  }
  if (!modelCheck.ok) {
    for (const o of modelCheck.offenders) {
      const where = o.provider ? `${o.provider}/${o.model}` : o.model;
      console.log(chalk.red(`[model] error: node "${o.nodeId}" → ${where}: ${o.reason}`));
    }
    errors += modelCheck.offenders.length;
  }
  console.log(`\n${diags.length + modelErrorCount} issue(s), ${errors} error(s)`);
  return errors > 0 ? 1 : 0;
}
