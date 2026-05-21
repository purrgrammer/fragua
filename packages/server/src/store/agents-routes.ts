// Sub-agent profiles HTTP endpoints — read-only surface backing the
// web UI's /agents and /projects/:id/agents views. Mirrors skills-routes
// but simpler: profiles are single .md files (no per-skill directory
// of scripts/refs/assets), so no `tree` or `file` endpoints — the
// detail response carries the body verbatim.
//
// Identity: `:locId = base64url(location)`. Profile names aren't
// globally unique across projects (project A and project B can both
// ship `reviewer.md`), so the absolute file path is the canonical
// handle.

import type { IEventStore } from "@fragua/store";
import type { AgentDefinition } from "@fragua/types";
import { discoverAgents } from "@fragua/workspace";
import { Hono } from "hono";

export interface AgentsRoutesOpts {
  store: IEventStore;
  /** User home directory — drives `~/.agents/agents/` + `~/.claude/agents/`. */
  homeDir: string;
  /** Server's startup cwd. Always unioned into the project enumeration. */
  cwd: string;
}

export function agentsRoutes(opts: AgentsRoutesOpts): Hono {
  const app = new Hono();

  app.get("/agents", async (c) => {
    const filterCwd = c.req.query("project_cwd");
    const strict = c.req.query("scope") === "project_only";
    const projectCwds = filterCwd !== undefined ? [filterCwd] : enumerateProjectCwds(opts);
    const { agents } = await discoverAgents({ projectCwds, homeDir: opts.homeDir });
    // `scope=project_only` drops user-scope rows so the project detail
    // tab shows exactly the profiles anchored to that project root.
    const filtered =
      strict && filterCwd !== undefined
        ? agents.filter((a) => a.scope === "project" && a.project_cwd === filterCwd)
        : agents;
    return c.json({ agents: filtered.map(toListItem) });
  });

  app.get("/agents/:locId", async (c) => {
    const def = await resolveByLocId(opts, c.req.param("locId"));
    if (!def) return c.json({ error: "agent not found", code: "not_found" }, 404);
    return c.json({
      agent: toListItem(def),
      // The body verbatim — what the sub-agent receives as its system
      // prompt on spawn (when no inline override is passed).
      body: def.body,
    });
  });

  return app;
}

function enumerateProjectCwds(opts: AgentsRoutesOpts): string[] {
  const known = opts.store.listCwds().map((r) => r.cwd);
  return Array.from(new Set([opts.cwd, ...known]));
}

async function resolveByLocId(opts: AgentsRoutesOpts, locId: string): Promise<AgentDefinition | undefined> {
  let location: string;
  try {
    location = decodeB64Url(locId);
  } catch {
    return undefined;
  }
  const { agents } = await discoverAgents({ projectCwds: enumerateProjectCwds(opts), homeDir: opts.homeDir });
  return agents.find((a) => a.location === location);
}

function toListItem(d: AgentDefinition): Record<string, unknown> {
  const locId = encodeB64Url(d.location);
  const out: Record<string, unknown> = {
    locId,
    name: d.name,
    description: d.description,
    location: d.location,
    sha256: d.sha256,
    bytes: d.bytes,
    scope: d.scope,
    source_dir: d.source_dir,
  };
  if (d.model !== undefined) out["model"] = d.model;
  if (d.provider !== undefined) out["provider"] = d.provider;
  if (d.allowed_tools !== undefined) out["allowed_tools"] = d.allowed_tools;
  if (d.project_cwd !== undefined) out["project_cwd"] = d.project_cwd;
  if (d.disabled_reason !== undefined) out["disabled_reason"] = d.disabled_reason;
  return out;
}

function encodeB64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function decodeB64Url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}
