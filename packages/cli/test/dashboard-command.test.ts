// Smoke tests for `dashboardCommand` — we can't render Ink into a real
// TTY in CI, but the command still has to resolve a run id from the
// newest directory, fail cleanly when no runs exist, and print a
// snapshot on the non-TTY path.

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardCommand } from "../src/commands/dashboard.tsx";

function tmpDir(name: string): string {
  return join(tmpdir(), `swarm-dash-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

async function seedRun(runsDir: string, id: string, events: unknown[]): Promise<void> {
  const dir = join(runsDir, id);
  await mkdir(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(join(dir, "events.jsonl"), lines + (lines ? "\n" : ""), "utf8");
}

describe("dashboardCommand — non-TTY snapshot path", () => {
  test("fails with a useful message when no runs exist", async () => {
    const cwd = tmpDir("no-runs");
    const code = await dashboardCommand({ runsDir: ".swarm/runs", cwd, follow: false });
    expect(code).toBe(1);
  });

  test("resolves --run-id and exits 0 in non-TTY mode", async () => {
    const cwd = tmpDir("explicit");
    const runsDir = join(cwd, ".swarm/runs");
    await seedRun(runsDir, "run-1", [
      { schema_version: 1, run_id: "run-1", timestamp: "2025-01-01T00:00:00.000Z", type: "pipeline.started", data: {} },
      {
        schema_version: 1,
        run_id: "run-1",
        timestamp: "2025-01-01T00:00:01.000Z",
        type: "node.started",
        node_id: "plan",
        data: {},
      },
    ]);
    const code = await dashboardCommand({ runId: "run-1", runsDir: ".swarm/runs", cwd, follow: false });
    expect(code).toBe(0);
  });

  test("picks the newest run when --run-id is omitted", async () => {
    const cwd = tmpDir("newest");
    const runsDir = join(cwd, ".swarm/runs");
    await seedRun(runsDir, "old-run", [
      {
        schema_version: 1,
        run_id: "old-run",
        timestamp: "2025-01-01T00:00:00.000Z",
        type: "pipeline.started",
        data: {},
      },
    ]);
    // Ensure the second write has a strictly-later mtime.
    await new Promise((r) => setTimeout(r, 20));
    await seedRun(runsDir, "new-run", [
      {
        schema_version: 1,
        run_id: "new-run",
        timestamp: "2025-01-02T00:00:00.000Z",
        type: "pipeline.started",
        data: {},
      },
    ]);
    const code = await dashboardCommand({ runsDir: ".swarm/runs", cwd, follow: false });
    expect(code).toBe(0);
  });

  test("fails when --run-id points at a missing directory", async () => {
    const cwd = tmpDir("missing");
    const runsDir = join(cwd, ".swarm/runs");
    await mkdir(runsDir, { recursive: true });
    // One unrelated run so newestRunId doesn't take the "no runs" branch.
    await seedRun(runsDir, "other", []);
    const code = await dashboardCommand({ runId: "does-not-exist", runsDir: ".swarm/runs", cwd, follow: false });
    expect(code).toBe(1);
  });
});
