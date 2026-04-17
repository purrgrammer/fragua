// `swarm providers` — list supported LLM providers and credentialing.

import { hasProviderCredentials, KNOWN_PROVIDERS } from "@swarm/agent";
import chalk from "chalk";

export function providersCommand(): number {
  console.log(chalk.bold("Supported providers (via pi-ai):\n"));
  let readyCount = 0;
  for (const p of KNOWN_PROVIDERS) {
    const ready = hasProviderCredentials(p.name);
    if (ready) readyCount++;
    const mark = ready ? chalk.green("✓") : chalk.dim("·");
    const nameCol = p.name.padEnd(22);
    const envCol = p.envVars.join(" | ").padEnd(60);
    console.log(`${mark} ${nameCol}${chalk.dim(envCol)}${chalk.dim(p.description)}`);
    if (p.exampleModel) {
      console.log(`    ${chalk.dim(`example: --provider ${p.name} --model ${p.exampleModel}`)}`);
    }
  }
  console.log(chalk.dim(`\n${readyCount}/${KNOWN_PROVIDERS.length} providers credentialed in current env`));
  return 0;
}
