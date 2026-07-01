// `fragua mcp` — inspect the project's MCP servers.
//
//   fragua mcp ls              list servers in <cwd>/.fragua/mcp.json + cred state
//   fragua mcp check [server]  connect (all, or one) and list the tools each exposes
//
// Read-only. Works off the current directory's mcp.json; no store, no daemon.
// See docs/proposals/mcp-tools.md.

import { createMcpConnector, loadMcpConfig, mcpConfigPath, mcpToolPrefix, resolveMcpServer } from "@fragua/workspace";
import chalk from "chalk";

export interface McpOptions {
  /** Project directory whose `.fragua/mcp.json` to read. Default `process.cwd()`. */
  cwd?: string;
}

export function mcpHelp(): number {
  console.log(`${chalk.bold("fragua mcp")} — inspect this project's MCP servers`);
  console.log("");
  console.log("  fragua mcp ls              list configured servers + credential state");
  console.log("  fragua mcp check [server]  connect and list the tools a server exposes");
  console.log("");
  console.log(chalk.dim("  Servers are declared in <cwd>/.fragua/mcp.json (env-var credentials)."));
  return 0;
}

export function mcpLsCommand(opts: McpOptions = {}): number {
  const cwd = opts.cwd ?? process.cwd();
  const load = loadMcpConfig(cwd);
  console.log(chalk.bold("mcp servers") + chalk.dim(`  (${mcpConfigPath(cwd)})`));
  if (!load.ok) {
    console.log(load.error ? chalk.red(`  ${load.error}`) : chalk.yellow("  no mcp.json found"));
    return load.error ? 1 : 0;
  }
  const names = Object.keys(load.servers);
  if (names.length === 0) {
    console.log(chalk.yellow("  no servers defined"));
    return 0;
  }
  for (const name of names) {
    const server = load.servers[name];
    if (!server) continue;
    const resolved = resolveMcpServer(server, process.env);
    const status = resolved.ok ? chalk.green("ready") : chalk.yellow(`missing env: ${resolved.missing.join(", ")}`);
    console.log(`  ${chalk.cyan(name)}  ${chalk.dim(server.command)}  ${status}`);
  }
  return 0;
}

export async function mcpCheckCommand(server: string | undefined, opts: McpOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const load = loadMcpConfig(cwd);
  if (!load.ok) {
    console.log(load.error ? chalk.red(load.error) : chalk.yellow(`no mcp.json at ${mcpConfigPath(cwd)}`));
    return 1;
  }
  const targets = server ? [server] : Object.keys(load.servers);
  if (targets.length === 0) {
    console.log(chalk.yellow("no servers defined"));
    return 0;
  }
  let set: Awaited<ReturnType<ReturnType<typeof createMcpConnector>["materialize"]>> | undefined;
  try {
    set = await createMcpConnector().materialize(targets, { cwd });
    let failed = false;
    for (const name of targets) {
      const unavailable = set.errors.find((e) => e.server === name && e.kind === "unavailable");
      if (unavailable) {
        console.log(`${chalk.cyan(name)}  ${chalk.red(unavailable.message)}`);
        failed = true;
        continue;
      }
      const prefix = mcpToolPrefix(name);
      const tools = set.tools.filter((t) => t.name.startsWith(prefix));
      console.log(`${chalk.cyan(name)}  ${chalk.green(`${tools.length} tool(s)`)}`);
      for (const t of tools) console.log(`  ${chalk.dim(t.name)}`);
      // A collision is non-fatal — the server is live and its other tools listed.
      for (const c of set.errors.filter((e) => e.server === name && e.kind === "collision")) {
        console.log(`  ${chalk.yellow(c.message)}`);
      }
    }
    return failed ? 1 : 0;
  } finally {
    await set?.dispose();
  }
}
