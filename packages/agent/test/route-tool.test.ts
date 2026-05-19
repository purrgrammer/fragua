// The `route` tool — backend route-tool synthesis + post-loop scan.
//
// docs/proposals/llm-routing.md Phase 4. A routing node (declares
// `routes=`) gets an ephemeral, per-call tool whose `name` parameter is
// enum-constrained to the declared routes. The tool sets
// `terminate: true` so pi-agent-core stops the loop after the batch;
// the chosen route is recovered post-loop by `findRouteToolCall`.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@mariozechner/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@mariozechner/pi-ai";
import type { EventType, NodeAttrs } from "@swarm/core";
import { CORE_TOOLS, LocalEnvironment, ToolRegistry } from "@swarm/workspace";
import { findRouteToolCall, PiLlmBackend } from "../src/backend.ts";

describe("findRouteToolCall", () => {
  function assistant(...content: unknown[]) {
    return { role: "assistant", content };
  }
  function toolCall(name: string, args: Record<string, unknown>) {
    return { type: "toolCall", id: `tc-${name}`, name, arguments: args };
  }

  test("returns the route name for an isolated assistant route call", () => {
    const r = findRouteToolCall([assistant(toolCall("route", { name: "small" }))]);
    expect(r).toEqual({ route: "small", isolated: true });
  });

  test("flags isolation=false when route shares a response with another tool call", () => {
    // Same assistant message contains route() AND a side-effect tool call.
    const r = findRouteToolCall([assistant(toolCall("route", { name: "hard" }), toolCall("read", { path: "x" }))]);
    expect(r).toEqual({ route: "hard", isolated: false });
  });

  test("returns null when no route call is in the transcript", () => {
    expect(findRouteToolCall([assistant({ type: "text", text: "I am done" })])).toBeNull();
    expect(findRouteToolCall([])).toBeNull();
    expect(findRouteToolCall([assistant(toolCall("read", { path: "x" }))])).toBeNull();
  });

  test("last route call wins across responses (shared-thread upstream routes don't shadow)", () => {
    // The shared-thread case: an upstream routing node's `route` call
    // appears earlier in the transcript than the current node's. The
    // scan must return the current node's (latest) call, not the
    // upstream one. Regression test for run 01ks012pq5jb5jyb0d.
    const r = findRouteToolCall([
      assistant(toolCall("route", { name: "upstream" })),
      assistant(toolCall("route", { name: "current" })),
    ]);
    expect(r?.route).toBe("current");
  });

  test("non-string route argument resolves to an empty route string", () => {
    // Provider-side enum normally prevents this; the post-loop scan
    // still returns a record so the backend can decide between
    // `route_not_picked` (null) and a malformed call (empty string +
    // isolated).
    const r = findRouteToolCall([assistant(toolCall("route", {}))]);
    expect(r).toEqual({ route: "", isolated: true });
  });
});

interface CapturedEvent {
  type: EventType;
  data: Record<string, unknown>;
}

function coreRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAll(CORE_TOOLS);
  return r;
}

interface RunWithRouteOpts {
  scratch: string;
  registry: ToolRegistry;
  attrs: NodeAttrs;
  /** Responses the faux provider replays in order. */
  responses: AssistantMessage[];
  /** Optional spy invoked with each request's `tools` array. */
  onContext?: (ctx: Context) => void;
}

async function runWithRoute(opts: RunWithRouteOpts): Promise<{
  events: CapturedEvent[];
  outcome: { status: string; route?: string; halt_reason?: string; failure_reason?: string };
}> {
  const faux = registerFauxProvider();
  try {
    const model = faux.getModel();
    // The factory shape lets us spy on the context (specifically the
    // advertised tool set) before returning a canned response. Falls
    // through to the canned list when no spy is wired.
    const factories = opts.responses.map((msg) => {
      return (ctx: Context) => {
        if (opts.onContext) opts.onContext(ctx);
        return msg;
      };
    });
    faux.setResponses(factories);

    const env = new LocalEnvironment({ cwd: opts.scratch });
    const backend = new PiLlmBackend({
      registry: opts.registry,
      env,
      resolveModel: () => model,
      defaultModel: { provider: model.provider, model: model.id },
      skills: [],
    });

    const events: CapturedEvent[] = [];
    const outcome = await backend.run({
      node: { id: "n1", type: "llm", attrs: opts.attrs },
      prompt: "decide a route",
      thread_id: undefined,
      signal: new AbortController().signal,
      run_id: "test-route-tool",
      workflow_sha: "sha",
      emit: async (type, data) => {
        events.push({ type, data });
      },
    });
    return {
      events,
      outcome: outcome as {
        status: string;
        route?: string;
        halt_reason?: string;
        failure_reason?: string;
      },
    };
  } finally {
    faux.unregister();
  }
}

describe("PiLlmBackend route tool synthesis", () => {
  test("routing node gets a route tool with the declared enum", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-route-enum-"));
    try {
      let advertised: { name: string; parameters: unknown }[] = [];
      const { outcome } = await runWithRoute({
        scratch,
        registry: coreRegistry(),
        attrs: { routes: ["small", "feature", "blocked"] },
        responses: [
          fauxAssistantMessage([fauxToolCall("route", { name: "small" }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
        onContext: (ctx) => {
          advertised = (ctx.tools ?? []).map((t) => ({ name: t.name, parameters: t.parameters }));
        },
      });
      const routeTool = advertised.find((t) => t.name === "route");
      expect(routeTool).toBeDefined();
      // Parameters schema: { type:"object", properties:{ name: { type:"string", enum:[...] } } }
      // — a plain JSONSchema enum the provider enforces, not the
      // anyOf+const shape Type.Union(Type.Literal) emits.
      const params = routeTool!.parameters as {
        properties?: { name?: { type?: string; enum?: string[] } };
      };
      expect(params.properties?.name?.type).toBe("string");
      expect(new Set(params.properties?.name?.enum ?? [])).toEqual(new Set(["small", "feature", "blocked"]));
      // Sanity: the run did terminate via route.
      expect(outcome.status).toBe("success");
      expect(outcome.route).toBe("small");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("non-routing node does not get a route tool", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-route-absent-"));
    try {
      let advertised: string[] = [];
      await runWithRoute({
        scratch,
        registry: coreRegistry(),
        attrs: {}, // no `routes`
        responses: [fauxAssistantMessage([fauxText("all done")], { stopReason: "stop" })],
        onContext: (ctx) => {
          advertised = (ctx.tools ?? []).map((t) => t.name);
        },
      });
      expect(advertised).not.toContain("route");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("an isolated route tool call yields a success outcome with route set", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-route-ok-"));
    try {
      const { outcome } = await runWithRoute({
        scratch,
        registry: coreRegistry(),
        attrs: { routes: ["feature", "small"] },
        responses: [
          fauxAssistantMessage([fauxToolCall("route", { name: "feature" }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
      });
      expect(outcome.status).toBe("success");
      expect(outcome.route).toBe("feature");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("route call alongside another tool call yields halt outcome with reason route_call_not_isolated", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-route-isolation-"));
    try {
      const { outcome } = await runWithRoute({
        scratch,
        registry: coreRegistry(),
        attrs: { routes: ["a", "b"] },
        responses: [
          // route() and read() in the SAME assistant message. The
          // batch is mixed (read() doesn't set terminate), so the
          // loop continues; the second response is a text-only stop
          // that lets the loop end naturally. The transcript scan
          // sees both blocks in the first assistant message and
          // reports isolated=false.
          fauxAssistantMessage(
            [
              fauxToolCall("route", { name: "a" }, { id: "tc1" }),
              fauxToolCall("read", { path: "AGENTS.md" }, { id: "tc2" }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
        ],
      });
      expect(outcome.status).toBe("fail");
      expect(outcome.halt_reason).toBe("route_call_not_isolated");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("routing node that ends without calling route yields halt outcome with reason route_not_picked", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-route-missing-"));
    try {
      const { outcome } = await runWithRoute({
        scratch,
        registry: coreRegistry(),
        attrs: { routes: ["a", "b"] },
        responses: [fauxAssistantMessage([fauxText("I considered it")], { stopReason: "stop" })],
      });
      expect(outcome.status).toBe("fail");
      expect(outcome.halt_reason).toBe("route_not_picked");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("route tool is force-included even when node.attrs.allowed_tools omits it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-route-force-allow-"));
    try {
      let advertised: string[] = [];
      const { outcome } = await runWithRoute({
        scratch,
        registry: coreRegistry(),
        // allowed_tools deliberately excludes "route". Force-include
        // must still wire it because routing-node failure to call
        // route() is structural (route_not_picked halt).
        attrs: { routes: ["a", "b"], allowed_tools: ["read"] },
        responses: [
          fauxAssistantMessage([fauxToolCall("route", { name: "a" }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
        onContext: (ctx) => {
          advertised = (ctx.tools ?? []).map((t) => t.name);
        },
      });
      expect(advertised).toContain("route");
      expect(outcome.status).toBe("success");
      expect(outcome.route).toBe("a");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("route tool is force-included even when node.attrs.denied_tools lists it", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-route-force-deny-"));
    try {
      let advertised: string[] = [];
      const { outcome } = await runWithRoute({
        scratch,
        registry: coreRegistry(),
        attrs: { routes: ["a", "b"], denied_tools: ["route"] },
        responses: [
          fauxAssistantMessage([fauxToolCall("route", { name: "b" }, { id: "tc1" })], {
            stopReason: "toolUse",
          }),
        ],
        onContext: (ctx) => {
          advertised = (ctx.tools ?? []).map((t) => t.name);
        },
      });
      expect(advertised).toContain("route");
      expect(outcome.status).toBe("success");
      expect(outcome.route).toBe("b");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test("abort wins over route when both are called", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "swarm-route-abort-precedence-"));
    try {
      const { outcome } = await runWithRoute({
        scratch,
        registry: coreRegistry(),
        attrs: { routes: ["a", "b"] },
        responses: [
          fauxAssistantMessage(
            [
              fauxToolCall("abort", { reason: "blocked by missing input" }, { id: "tc1" }),
              fauxToolCall("route", { name: "a" }, { id: "tc2" }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxText("done")], { stopReason: "stop" }),
        ],
      });
      // abort precedence: fail with the abort reason, non_retryable.
      // The route_call_not_isolated path does NOT fire because abort
      // short-circuits before the route scan.
      expect(outcome.status).toBe("fail");
      expect(outcome.failure_reason).toBe("blocked by missing input");
      expect(outcome.halt_reason).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
