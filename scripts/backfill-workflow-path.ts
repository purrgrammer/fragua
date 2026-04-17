// One-off backfill: patch the first event of each existing run under
// `.swarm/runs/*/events.jsonl` to include `workflow_path` and the raw DOT
// `workflow_source` on `pipeline.started`. The server derives the display
// name from the path basename (e.g. "build-feature") and renders the graph
// SVG from `workflow_source`, so without it `/graph.svg` 404s.
//
// All pre-existing local runs used `workflows/build-feature.dot`.
//
// Idempotent: leaves `workflow_path`/`workflow_source` untouched if already
// set. Also removes any stale `workflow_label` written by a prior version of
// this script that mistakenly used the Graphviz caption as the display name.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const WORKFLOW_PATH = "workflows/build-feature.dot";

const runsDir = resolve(process.cwd(), ".swarm/runs");
let workflowSource: string | undefined;
try {
  workflowSource = await readFile(resolve(process.cwd(), WORKFLOW_PATH), "utf8");
} catch {
  console.warn(`note: ${WORKFLOW_PATH} not readable — skipping workflow_source backfill`);
}

const entries = await readdir(runsDir, { withFileTypes: true });
let patched = 0;
let skipped = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const file = join(runsDir, entry.name, "events.jsonl");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    skipped++;
    continue;
  }
  const nl = text.indexOf("\n");
  if (nl < 0) {
    skipped++;
    continue;
  }
  const firstLine = text.slice(0, nl);
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    console.warn(`skip ${entry.name}: first line not JSON`);
    skipped++;
    continue;
  }
  if (ev.type !== "pipeline.started") {
    console.warn(`skip ${entry.name}: first event is ${String(ev.type)}`);
    skipped++;
    continue;
  }
  const data = { ...((ev.data as Record<string, unknown> | undefined) ?? {}) };
  let changed = false;
  if (data.workflow_path === undefined) {
    data.workflow_path = WORKFLOW_PATH;
    changed = true;
  }
  if (data.workflow_source === undefined && workflowSource !== undefined) {
    data.workflow_source = workflowSource;
    changed = true;
  }
  if ("workflow_label" in data) {
    delete data.workflow_label;
    changed = true;
  }
  if (!changed) {
    skipped++;
    continue;
  }
  ev.data = data;
  const rewritten = JSON.stringify(ev) + text.slice(nl);
  await writeFile(file, rewritten, "utf8");
  patched++;
  console.log(`patched ${entry.name}`);
}

console.log(`\ndone: patched=${patched} skipped=${skipped}`);
