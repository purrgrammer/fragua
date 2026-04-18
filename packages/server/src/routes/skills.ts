// GET /skills — list installed skills (catalog metadata only).
// GET /skills/:name — full SKILL.md body + metadata.
//
// Read-only by design. Authoring (create/edit/delete SKILL.md) is a
// filesystem concern — keep the server surface small and dodge
// write-permission questions.

import {
  type EventSource,
  foldSkillUsage,
  type SkillActivationsByRun,
  skillActivationsProjection,
} from "@swarm/events";
import { Hono } from "hono";
import type { RunReader, SkillReader } from "../ports.ts";
import { sourceFromRunReader } from "../ports.ts";

export interface SkillsRouteOptions {
  skillReader: SkillReader;
  /** Optional: when provided, each GET /skills/:name response includes a
   * `usage` block listing the most recent runs that actually loaded the
   * skill via `local:load_skill` (or pre-loaded it via `local:subagent`).
   * Catalog-only advertisements don't count — see
   * `skillActivationsProjection`. */
  runReader?: RunReader;
  /** Max runs listed in the `usage.runs` array. Default 25. */
  maxUsageRuns?: number;
}

export function skillsRoutes(opts: SkillsRouteOptions): Hono {
  const app = new Hono();
  const maxUsage = opts.maxUsageRuns ?? 25;

  app.get("/skills", async (c) => {
    const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
    const list = await opts.skillReader.list({ refresh });
    return c.json(list);
  });

  app.get("/skills/:name", async (c) => {
    const name = c.req.param("name");
    const skill = await opts.skillReader.read(name);
    if (!skill) {
      return c.json({ error: `skill "${name}" not found` }, 404);
    }
    if (!opts.runReader) {
      return c.json(skill);
    }
    const usage = await collectUsage(opts.runReader, name, maxUsage);
    return c.json({ ...skill, usage });
  });

  return app;
}

/** Fold `skillActivationsProjection` across every run, then filter to the
 * target skill name. Sorted by most-recent-first (lexicographic on run id —
 * swarm's run ids start with `Date.now()`, so lexicographic ≈ chronological). */
async function collectUsage(reader: RunReader, name: string, max: number): Promise<{ runs: string[]; count: number }> {
  const source: EventSource = sourceFromRunReader(reader);
  const ids = await source.listRuns();
  // Process newest runs first so the truncation at `max` keeps recent data.
  ids.sort((a, b) => b.localeCompare(a));
  const byRun: Array<{ runId: string; byRun: SkillActivationsByRun }> = [];
  for (const runId of ids) {
    const events = await source.readRun(runId);
    if (!events) continue;
    const proj = await skillActivationsProjection(events);
    if (Object.keys(proj).length > 0) byRun.push({ runId, byRun: proj });
  }
  const usage = foldSkillUsage(byRun);
  const entry = usage[name];
  if (!entry) return { runs: [], count: 0 };
  return { runs: entry.runs.slice(0, max), count: entry.count };
}
