// End-to-end loader test: write a fixture extension to a temp dir,
// load it, verify the registered tool is wrapped correctly and routes
// `swarmContext` into the underlying `ToolDefinition.execute`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadExtensions } from "../../src/extensions/index.ts";
import { LocalEnvironment } from "../../src/local-env.ts";

// Fixtures live inside the workspace tree so Bun's `node_modules`
// walk-up reaches the repo root and `@swarm/extension` resolves.
// `tmpdir()` would resolve outside any node_modules graph.
const FIXTURE_BASE = resolve(__dirname, "__sandbox__");

let tmp: string;

beforeEach(async () => {
  tmp = resolve(FIXTURE_BASE, Math.random().toString(36).slice(2));
  await mkdir(resolve(tmp, ".swarm/extensions"), { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  // Best-effort cleanup of the empty sandbox parent.
  await rm(FIXTURE_BASE, { recursive: true, force: true }).catch(() => {});
});

async function writeFixture(name: string, src: string): Promise<void> {
  await writeFile(resolve(tmp, ".swarm/extensions", name), src);
}

const ECHO_FIXTURE = `
import { defineTool, type SwarmAPI } from "@swarm/extension";
import { Type } from "@sinclair/typebox";

const echo = defineTool({
  name: "echo_back",
  label: "Echo",
  description: "Echo a string back, plus the run ctx fields.",
  parameters: Type.Object({ msg: Type.String() }),
  async execute(_id, args, _signal, _onUpdate, ctx) {
    return {
      content: [{ type: "text", text: \`\${args.msg} | run=\${ctx.runId} node=\${ctx.nodeId} iter=\${ctx.iteration}\` }],
      details: { msg: args.msg, runId: ctx.runId, hasSummarise: ctx.summarise !== undefined },
    };
  },
});

export default function (sw: SwarmAPI) {
  sw.registerTool(echo);
}
`;

describe("loadExtensions", () => {
  test("loads a fixture extension and adapts its tool", async () => {
    await writeFixture("hello.ts", ECHO_FIXTURE);

    const { extensions, tools, warnings } = await loadExtensions({ cwd: tmp });
    expect(warnings).toEqual([]);
    expect(extensions).toHaveLength(1);
    expect(extensions[0]!.error).toBeUndefined();
    expect(extensions[0]!.extensionId).toBe("project:hello");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("echo_back");
    expect(tools[0]!.idempotent).toBe(false); // v0 default
  });

  test("adapter threads swarmContext through to execute()", async () => {
    await writeFixture("hello.ts", ECHO_FIXTURE);
    const { tools } = await loadExtensions({ cwd: tmp });
    const tool = tools[0]!;

    const env = new LocalEnvironment({ cwd: tmp });
    const result = await tool.execute({ msg: "hi" }, env, {
      swarmContext: {
        runId: "r1",
        nodeId: "n1",
        iteration: 3,
        http: { fetch: globalThis.fetch },
        emit: () => {},
      },
    });

    expect(result.is_error).toBeFalsy();
    expect(result.content?.[0]?.type).toBe("text");
    if (result.content?.[0]?.type === "text") {
      expect(result.content[0].text).toBe("hi | run=r1 node=n1 iter=3");
    }
    const data = result.data as { msg: string; runId: string; hasSummarise: boolean };
    expect(data.msg).toBe("hi");
    expect(data.runId).toBe("r1");
    expect(data.hasSummarise).toBe(false);
  });

  test("errors when extension is called without swarmContext", async () => {
    await writeFixture("hello.ts", ECHO_FIXTURE);
    const { tools } = await loadExtensions({ cwd: tmp });
    const tool = tools[0]!;

    const env = new LocalEnvironment({ cwd: tmp });
    const result = await tool.execute({ msg: "hi" }, env);

    expect(result.is_error).toBe(true);
    expect(result.text).toContain("swarmContext");
  });

  test("flags extension files with no default-export", async () => {
    await writeFixture("bad.ts", "export const x = 1;");
    const { extensions, warnings } = await loadExtensions({ cwd: tmp });
    expect(extensions).toHaveLength(1);
    expect(extensions[0]!.error).toContain("default-export");
    expect(warnings.some((w) => w.includes("project:bad"))).toBe(true);
  });

  test("flags extensions whose factory throws", async () => {
    await writeFixture("boom.ts", `export default function () { throw new Error("kaboom"); }`);
    const { extensions, warnings } = await loadExtensions({ cwd: tmp });
    expect(extensions[0]!.error).toContain("kaboom");
    expect(warnings.some((w) => w.includes("project:boom"))).toBe(true);
  });

  test("rejects duplicate tool names within one extension", async () => {
    await writeFixture(
      "dup.ts",
      `
import { defineTool, type SwarmAPI } from "@swarm/extension";
import { Type } from "@sinclair/typebox";
const t = defineTool({
  name: "t",
  label: "T",
  description: "d",
  parameters: Type.Object({}),
  async execute() { return { content: [], details: {} }; },
});
export default function (sw: SwarmAPI) {
  sw.registerTool(t);
  sw.registerTool(t);
}
`,
    );
    const { extensions } = await loadExtensions({ cwd: tmp });
    expect(extensions[0]!.error).toContain("twice");
  });

  test("renderText feeds the workspace tool's text output", async () => {
    await writeFixture(
      "rendered.ts",
      `
import { defineTool, type SwarmAPI } from "@swarm/extension";
import { Type } from "@sinclair/typebox";
const t = defineTool({
  name: "rendered",
  label: "R",
  description: "d",
  parameters: Type.Object({}),
  renderText(result) { return "**rendered**: " + (result.details).label; },
  async execute() { return { content: [{ type: "text", text: "raw" }], details: { label: "ok" } }; },
});
export default function (sw: SwarmAPI) { sw.registerTool(t); }
`,
    );
    const { tools } = await loadExtensions({ cwd: tmp });
    const env = new LocalEnvironment({ cwd: tmp });
    const result = await tools[0]!.execute({}, env, {
      swarmContext: {
        runId: "r",
        nodeId: "n",
        iteration: 0,
        http: { fetch: globalThis.fetch },
        emit: () => {},
      },
    });
    expect(result.text).toBe("**rendered**: ok");
  });
});
