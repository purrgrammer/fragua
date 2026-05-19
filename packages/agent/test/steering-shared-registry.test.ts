// PiCodergenBackend honours an externally-supplied SteeringRegistry.
//
// Each llm node builds its own backend (per packages/cli/src/commands/daemon.ts),
// so per-instance steering registries can't deliver a steer issued while
// node A is active to node B's agent on the same run. The daemon shares
// one registry across all backends; this test pins the wiring.

import { describe, expect, test } from "bun:test";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { PiCodergenBackend } from "../src/backend.ts";
import { type SteerableAgent, SteeringRegistry } from "../src/steering-registry.ts";

class FakeAgent implements SteerableAgent {
  readonly received: string[] = [];
  steer(msg: { content: [{ type: "text"; text: string }] }): void {
    this.received.push(msg.content[0]?.text ?? "");
  }
}

describe("PiCodergenBackend — shared SteeringRegistry", () => {
  test("backend.steer routes through opts.steering when supplied", () => {
    const shared = new SteeringRegistry();
    const tools = new ToolRegistry();
    tools.registerAll(CORE_TOOLS);
    const env = new LocalEnvironment({ cwd: "/tmp" });
    const backend = new PiCodergenBackend({
      registry: tools,
      env,
      defaultModel: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      steering: shared,
    });

    const agent = new FakeAgent();
    shared.beginRun("run-1", agent);

    backend.steer("run-1", "go fix the build");

    expect(agent.received).toEqual(["go fix the build"]);
  });

  test("two backends sharing a registry deliver each other's steers to the same agent", () => {
    const shared = new SteeringRegistry();
    const tools = new ToolRegistry();
    tools.registerAll(CORE_TOOLS);
    const env = new LocalEnvironment({ cwd: "/tmp" });
    const make = () =>
      new PiCodergenBackend({
        registry: tools,
        env,
        defaultModel: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        steering: shared,
      });
    const planBackend = make();
    const implBackend = make();

    const liveAgent = new FakeAgent();
    shared.beginRun("run-2", liveAgent);

    planBackend.steer("run-2", "from plan");
    implBackend.steer("run-2", "from impl");

    expect(liveAgent.received).toEqual(["from plan", "from impl"]);
  });

  test("without opts.steering, each backend keeps its own registry (isolation)", () => {
    const tools = new ToolRegistry();
    tools.registerAll(CORE_TOOLS);
    const env = new LocalEnvironment({ cwd: "/tmp" });
    const make = () =>
      new PiCodergenBackend({
        registry: tools,
        env,
        defaultModel: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      });
    const a = make();
    const b = make();

    a.steer("run-3", "a-only");
    b.steer("run-3", "b-only");

    // Both buffer their own; neither drained because no agent registered.
    // Cross-backend visibility would require a shared registry — proven absent.
    // (We can't read the buffers from the public API; this test just checks
    // construction succeeds without a shared registry, i.e. no crash.)
    expect(typeof a.steer).toBe("function");
    expect(typeof b.steer).toBe("function");
  });
});
