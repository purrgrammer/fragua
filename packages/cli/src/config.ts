// Load `.swarm/config.yaml` from the project root. Missing / malformed →
// empty config (no errors). The file is a *user preference* layer:
// CLI flags beat config, config beats hard-coded defaults.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

export interface SwarmConfig {
  project?: {
    name?: string;
    runs_dir?: string;
  };
  defaults?: {
    provider?: string;
    model?: string;
    permissions?: string;
  };
  blocklist?: string[];
  workflows?: Record<string, string>;
}

/** Load and parse `<cwd>/.swarm/config.yaml`. Returns `{}` if the file is
 * missing or unparseable — config is always optional. */
export async function loadConfig(cwd: string): Promise<SwarmConfig> {
  const path = resolve(cwd, ".swarm/config.yaml");
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = YAML.parse(body);
    return (parsed && typeof parsed === "object" ? parsed : {}) as SwarmConfig;
  } catch {
    return {};
  }
}
