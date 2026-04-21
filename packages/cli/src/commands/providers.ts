// `swarm providers …` — inspect + test LLM provider credentials.
//
// The registry (built-in models from pi-ai + custom providers from
// ~/.swarm/models.json) is the source of truth; this command just
// presents it.

import { AuthStorage, getSwarmHome, ModelRegistry } from "@swarm/agent";
import chalk from "chalk";

export function providersListCommand(): number {
  const auth = AuthStorage.create();
  const registry = ModelRegistry.create(auth);

  const byProvider = new Map<string, number>();
  for (const m of registry.getAll()) {
    byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
  }

  if (byProvider.size === 0) {
    console.log(chalk.dim("no providers registered — unexpected; pi-ai should bundle built-ins"));
    return 0;
  }

  console.log(chalk.bold("Providers (via pi-ai registry):\n"));
  const rows = [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  let credentialed = 0;
  for (const [name, count] of rows) {
    const ready = auth.hasAuth(name);
    if (ready) credentialed++;
    const mark = ready ? chalk.green("✓") : chalk.dim("·");
    const nameCol = name.padEnd(24);
    const countCol = `${count} model${count === 1 ? "" : "s"}`.padEnd(12);
    console.log(`${mark} ${nameCol}${chalk.dim(countCol)}`);
  }
  const err = registry.getError();
  if (err) {
    console.log();
    console.log(chalk.yellow(`models.json: ${err}`));
  }
  console.log(chalk.dim(`\n${credentialed}/${rows.length} providers credentialed`));
  console.log(chalk.dim(`swarm home: ${getSwarmHome()}`));
  console.log(chalk.dim(`run \`swarm providers add <name>\` to configure one`));
  return 0;
}

export function providersHelpCommand(): number {
  console.log(chalk.bold("swarm providers — manage LLM provider credentials + custom models\n"));
  console.log("Subcommands:");
  console.log(`  ${chalk.cyan("ls")}                  List all providers + credentialed status`);
  console.log(`  ${chalk.cyan("add <provider>")}      Add credentials interactively (not yet implemented)`);
  console.log(`  ${chalk.cyan("rm <provider>")}       Remove stored credentials (not yet implemented)`);
  console.log(`  ${chalk.cyan("test <provider>")}     Stream a 1-token call to verify (not yet implemented)`);
  console.log(`  ${chalk.cyan("login <provider>")}    Run the OAuth flow (not yet implemented)`);
  console.log(`  ${chalk.cyan("logout <provider>")}   Clear OAuth tokens (not yet implemented)`);
  console.log();
  console.log(chalk.dim("Credentials live at ~/.swarm/auth.json (0600)."));
  console.log(chalk.dim("Custom providers + model overrides live at ~/.swarm/models.json."));
  console.log(chalk.dim("Read-only fallback: ~/.pi/agent/{auth,models}.json (pi-coding-agent)."));
  return 0;
}
