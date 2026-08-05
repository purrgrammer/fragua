// End-to-end guard for the provider prompt-cache prefix.
//
// Providers cache by prefix, in wire order: tool definitions, then the
// system prompt, then messages. Anthropic's pi-ai provider places ONE
// cache_control marker at the end of the system prompt block, so a single
// differing byte anywhere in tools+system invalidates that whole segment —
// position within the system prompt is irrelevant.
//
// These tests observe what the provider actually receives (via a faux
// response factory, which is handed the real `Context`) rather than
// re-deriving it, so they fail if any layer between the backend and the
// wire reintroduces a per-run byte.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { ExecutionEnvironment, NodeAttrs } from "@fragua/core";
import type { Skill } from "@fragua/types";
import { CORE_TOOLS, ToolRegistry } from "@fragua/workspace";
import { createPiMockBackend, fauxAssistantMessage, fauxText } from "../src/mock.ts";

interface Captured {
  toolNames: string[];
  systemPrompt: string;
}

/** The project root both simulated runs share. Skills are discovered and
 *  filtered against the PROJECT root, not the per-run worktree, so it must be
 *  the same string across runs — exactly as in production. */
const PROJECT_ROOT = "/repo";

function projectSkill(name: string): Skill {
  return {
    name,
    description: `${name} patterns`,
    location: join(PROJECT_ROOT, `.agents/skills/${name}/SKILL.md`),
    skill_dir: join(PROJECT_ROOT, `.agents/skills/${name}`),
    sha256: "a".repeat(64),
    bytes: 128,
    scope: "project",
    source_dir: join(PROJECT_ROOT, ".agents/skills"),
    project_cwd: PROJECT_ROOT,
  };
}

/** Project-scope skills wired into every capture, so the rendered
 *  `<available_skills>` catalogue is non-empty — otherwise the byte-identity
 *  assertions below would pass trivially, never exercising the catalogue path
 *  at all. Deliberately MORE THAN ONE, and passed in non-alphabetical order:
 *  with a single entry any comparator looks stable, so multi-item ordering is
 *  the only way this test can see a locale-dependent sort creeping back into a
 *  cache-prefix input. */
const PROJECT_SKILLS: Skill[] = [projectSkill("frontend"), projectSkill("backend"), projectSkill("design")];

/** Worktree-shaped env: `cwd()` is the per-run worktree, `projectCwd()` is the
 *  shared repo root. `LocalEnvironment` collapses the two (cwd === projectCwd),
 *  which would make a cross-run comparison model the wrong thing — the whole
 *  point is that the worktree varies while the project does not. */
function worktreeEnv(worktreePath: string): ExecutionEnvironment {
  return {
    cwd: () => worktreePath,
    projectCwd: () => PROJECT_ROOT,
    // No AGENTS.md on disk: loadContextFiles records a warning and contributes
    // an empty <project-conventions> block, identically for both runs. Carries
    // `code` so a consumer that branches on `err.code === "ENOENT"` takes the
    // same path here as against a real fs.
    readFile: async (path: string) => {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    },
    writeFile: async () => {},
    exists: async () => false,
    listDir: async () => [],
    glob: async () => [],
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
  };
}

/** Drive one real `backend.run()` against the faux provider and capture the
 *  `Context` the provider is handed. Routed through `createPiMockBackend` so
 *  this test tracks the real `PiLlmBackend` constructor signature rather than
 *  a private copy of it. */
async function captureContext(opts: { cwd: string; runId: string; attrs: NodeAttrs }): Promise<Captured> {
  let seen: Context | undefined;
  const handle = createPiMockBackend({
    registry: (() => {
      const r = new ToolRegistry();
      r.registerAll(CORE_TOOLS);
      return r;
    })(),
    env: worktreeEnv(opts.cwd),
    systemPrompt: "you are the coding agent",
    skills: PROJECT_SKILLS,
    responses: [
      (context) => {
        seen = context;
        return fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
      },
    ],
  });

  try {
    await handle.backend.run({
      node: { id: "n1", type: "llm", attrs: opts.attrs },
      prompt: "do the thing",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: opts.runId,
      workflow_sha: "sha",
    });

    if (!seen) throw new Error("faux provider was never called");
    return {
      toolNames: (seen.tools ?? []).map((t) => t.name),
      systemPrompt: seen.systemPrompt ?? "",
    };
  } finally {
    handle.dispose();
  }
}

// Two consecutive runs of one project, each in its own worktree — the exact
// shape the provisioner produces.
const RUN_A = {
  id: "01jaaaaaaaaaaaaaaaaaaaaaaa",
  worktree: `${PROJECT_ROOT}/.fragua/worktrees/01jaaaaaaaaaaaaaaaaaaaaaaa`,
};
const RUN_B = {
  id: "01jbbbbbbbbbbbbbbbbbbbbbbb",
  worktree: `${PROJECT_ROOT}/.fragua/worktrees/01jbbbbbbbbbbbbbbbbbbbbbbb`,
};

describe("prompt-cache prefix stability", () => {
  test("tool definitions are name-sorted regardless of allowed_tools order", async () => {
    const forward = await captureContext({
      cwd: RUN_A.worktree,
      runId: RUN_A.id,
      attrs: { allowed_tools: ["bash", "read", "grep"] },
    });
    const reversed = await captureContext({
      cwd: RUN_B.worktree,
      runId: RUN_B.id,
      attrs: { allowed_tools: ["grep", "read", "bash"] },
    });

    // Same effective set declared in two orders → identical wire bytes.
    expect(forward.toolNames).toEqual(reversed.toolNames);
    expect(forward.toolNames).toEqual([...forward.toolNames].sort());
    // `abort` is force-included despite not being in `allowed_tools`, and
    // the sortedness assertion above is what pins it to its sorted position
    // rather than the tail where it used to be appended.
    expect(forward.toolNames).toContain("abort");
  });

  test("system prompt is byte-identical across two runs in different worktrees", async () => {
    // This is the exact comparison that failed before the change: run id and
    // worktree path were interpolated into the <environment> block, so no two
    // runs of the same project ever shared a cached tools+system segment.
    const runA = await captureContext({ cwd: RUN_A.worktree, runId: RUN_A.id, attrs: {} });
    const runB = await captureContext({ cwd: RUN_B.worktree, runId: RUN_B.id, attrs: {} });

    // Guard the guard: the catalogue really is rendered, so the equality
    // below is a claim about assembled content and not about two empty
    // strings. Locations are under the shared project root, which is
    // precisely why they stay stable while the worktree moves.
    expect(runA.systemPrompt).toContain("<available_skills>");
    for (const s of PROJECT_SKILLS) expect(runA.systemPrompt).toContain(s.location);

    // Multi-item ordering is byte-stable: the catalogue is a cache-prefix
    // input, so the order it renders in has to be a pure function of the
    // names. Assert the rendered POSITIONS, not just that the names appear —
    // presence alone would pass under any comparator at all.
    const renderedOrder = PROJECT_SKILLS.map((s) => ({
      name: s.name,
      at: runA.systemPrompt.indexOf(`<name>${s.name}</name>`),
    }));
    expect(renderedOrder.every((e) => e.at >= 0)).toBe(true);
    expect([...renderedOrder].sort((a, b) => a.at - b.at).map((e) => e.name)).toEqual(
      [...PROJECT_SKILLS].map((s) => s.name).sort(),
    );

    expect(runA.systemPrompt).toBe(runB.systemPrompt);
    expect(runA.toolNames).toEqual(runB.toolNames);

    // Belt and braces: name the specific bytes that used to leak.
    expect(runA.systemPrompt).not.toContain(RUN_A.id);
    expect(runA.systemPrompt).not.toContain(RUN_A.worktree);
    expect(runA.systemPrompt).not.toContain("run_id");
  });
});
