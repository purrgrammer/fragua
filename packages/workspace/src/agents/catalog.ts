// Render the catalogue block injected into the parent codergen call's
// system prompt when the `agent` tool is in the pool. One bullet per
// discovered profile (name + description). Bodies are NOT included
// here — they materialise on spawn into the sub-agent's own system
// prompt via `materialiseForChild`.

import type { AgentDefinition } from "@swarm/types";

const HEADER = "## Available sub-agents";
const PREAMBLE = [
  "Spawn one of these by calling the `agent` tool with `agent: <name>`.",
  "Their full system prompts are loaded only when spawned, not here.",
].join(" ");

export function renderAgentsCatalog(defs: readonly AgentDefinition[]): string {
  const visible = defs.filter((d) => !d.disabled_reason);
  if (visible.length === 0) return "";
  const sorted = [...visible].sort((a, b) => a.name.localeCompare(b.name));
  const bullets = sorted.map((d) => `- \`${d.name}\` — ${d.description}`);
  return [HEADER, "", PREAMBLE, "", ...bullets].join("\n");
}

/** Lookup by exact name. Catalogues are tiny (<100 entries) so a linear
 *  scan keeps the call site honest; hide the data structure choice. */
export function lookupAgentDef(catalog: readonly AgentDefinition[], name: string): AgentDefinition | undefined {
  return catalog.find((d) => d.name === name && !d.disabled_reason);
}

/** Pass-through filter for now. Kept as an explicit seam for the V3
 *  per-node `agents` allowlist — when that lands, this is the single
 *  call site to extend. */
export function filterAgentsForNode(
  defs: readonly AgentDefinition[],
  _attrs: { agents?: readonly string[]; agents_disabled?: boolean },
): AgentDefinition[] {
  return defs.filter((d) => !d.disabled_reason);
}
