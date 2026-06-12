// Integration tests for the store-backed HTTP routes.
//
// Covers:
//   - All seven intent-write endpoints land an event on the store
//   - GET /runs/:id/events supports sinceSeq filtering
//   - GET /metrics/global aggregates via generated columns + json_each pivot
//   - P19: SSE replay via Last-Event-ID

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { SqliteStore, sha256Hex } from "@fragua/store";
import { FEED_EVENT_KINDS, RUN_STATUSES } from "@fragua/types";
import type { WorkflowDetail, WorkflowReader, WorkflowReadOptions, WorkflowSummary } from "../../src/ports.ts";
import { createRoutes } from "../../src/store/routes.ts";

let store: SqliteStore;
let server: { fetch: (req: Request) => Response | Promise<Response> };
let workflowReader: TestWorkflowReader;

interface TestWorkflowReader extends WorkflowReader {
  set(name: string, source: string, opts?: { cwd?: string }): void;
}

function createTestWorkflowReader(): TestWorkflowReader {
  // Keyed by `${cwd ?? ""}::${name}` so the same name can live under
  // distinct sources (global = "" cwd, project-local = an actual path).
  // Lookup precedence with no `cwd` set in opts: global first, then any
  // project — matches the multi-source filesystem reader's contract.
  const entries = new Map<string, WorkflowDetail>();
  const keyOf = (cwd: string, name: string): string => `${cwd}::${name}`;
  return {
    async list(): Promise<WorkflowSummary[]> {
      return Array.from(entries.values()).map(({ source: _src, ...summary }) => summary);
    },
    async read(name: string, opts?: WorkflowReadOptions): Promise<WorkflowDetail | undefined> {
      const requestedCwd = opts?.cwd;
      if (requestedCwd === undefined) {
        const globalHit = entries.get(keyOf("", name));
        if (globalHit) return globalHit;
        for (const [k, v] of entries) {
          if (k.endsWith(`::${name}`)) return v;
        }
        return undefined;
      }
      return entries.get(keyOf(requestedCwd, name));
    },
    set(name, source, opts) {
      const cwd = opts?.cwd ?? "";
      const detail: WorkflowDetail = { name, path: `${cwd}/${name}.yaml`, sha: "x", source };
      if (cwd !== "") detail.cwd = cwd;
      entries.set(keyOf(cwd, name), detail);
    },
  };
}

beforeEach(() => {
  store = new SqliteStore({ path: ":memory:" });
  store.saveWorkflow(
    "wf",
    "t",
    "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
    serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n")),
    CURRENT_IR_VERSION,
  );
  workflowReader = createTestWorkflowReader();
  server = createRoutes({ store, workflowReader });
});

afterEach(() => {
  store.close();
});

async function req(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return server.fetch(new Request(`http://test${path}`, init));
}

describe("POST /workflows — upload", () => {
  test("accepts YAML source, returns sha, persists via saveWorkflow", async () => {
    const res = await req("POST", "/workflows", {
      name: "hello",
      source: "name: hello\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha: string; name: string };
    expect(body.name).toBe("hello");
    expect(body.sha).toMatch(/^[0-9a-f]{64}$/);
    const wf = store.getWorkflow(body.sha);
    expect(wf?.name).toBe("hello");
    // (A): the upload persists the canonical IR (loc-stripped Graph JSON) +
    // its version, so the dispatch loader deserializes instead of re-parsing.
    expect(wf?.irVersion).toBe(2);
    expect(wf?.ir).toBeTruthy();
    const ir = JSON.parse(wf!.ir!) as { nodes: Record<string, unknown>; edges: unknown[] };
    expect(Object.keys(ir.nodes)).toContain("work");
    expect(wf!.ir!).not.toContain('"loc"');
  });

  test("rejects missing fields", async () => {
    const res1 = await req("POST", "/workflows", { name: "x" });
    expect(res1.status).toBe(400);
    const res2 = await req("POST", "/workflows", {
      source: "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
    });
    expect(res2.status).toBe(400);
  });

  test("rejects unparseable workflow source with 400 + invalid_workflow code", async () => {
    const source = "name: [unterminated\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n";
    const sha = sha256Hex(source);
    const res = await req("POST", "/workflows", { name: "bad", source });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_workflow");
    expect(body.error).toMatch(/workflow/i);
    expect(store.getWorkflow(sha)).toBeNull();
  });

  test("idempotent on same source — same sha, no duplicate row", async () => {
    const src = "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n";
    const a = (await (await req("POST", "/workflows", { name: "x", source: src })).json()) as { sha: string };
    const b = (await (await req("POST", "/workflows", { name: "x", source: src })).json()) as { sha: string };
    expect(a.sha).toBe(b.sha);
  });

  test("rejects a parseable but validator-invalid workflow with 400 + invalid_workflow (E-codes in detail)", async () => {
    // A fan-out branch resolving to a run terminal — parseable, but the mint
    // refuses it (reason: "invalid"). The route must surface the boundary
    // contract: 400 + code invalid_workflow + the E-codes in the detail.
    const res = await req("POST", "/workflows", {
      name: "bad",
      source: `name: bad
steps:
  begin: { type: llm, prompt: x, next: fan }
  fan: { type: parallel, branches: [a, b], next: synth }
  a: { type: llm, prompt: x, next: exit }
  b: { type: llm, prompt: x, next: synth }
  synth: { type: llm, prompt: done, next: exit }
`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe("invalid_workflow");
    expect(body.detail).toMatch(/E0\d\d/);
  });

  test("rejects malformed timeout attr with 400 + invalid_timeout_attr code", async () => {
    const res = await req("POST", "/workflows", {
      name: "bad",
      source: `name: bad
steps:
  impl:
    type: llm
    prompt: x
    next: exit
    timeout: "garbage"
`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string; offender: { nodeId: string; attr: string } };
    expect(body.code).toBe("invalid_timeout_attr");
    expect(body.offender.nodeId).toBe("impl");
    expect(body.offender.attr).toBe("timeout");
    expect(body.error).toMatch(/impl/);
    expect(body.error).toMatch(/garbage/);
  });

  test("accepts max_ms=0 as the unbounded sentinel for llm", async () => {
    const res = await req("POST", "/workflows", {
      name: "ok",
      source: `name: ok
steps:
  a: {type: llm, prompt: x, max_ms: 0, next: exit}
`,
    });
    expect(res.status).toBe(200);
  });

  test("rejects negative max_ms", async () => {
    const res = await req("POST", "/workflows", {
      name: "bad",
      source: `name: bad
steps:
  a:
    type: llm
    prompt: x
    next: exit
    max_ms: -1
`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_timeout_attr");
  });

  test('accepts timeout="0" / "0s" as the unbounded sentinel for llm', async () => {
    for (const t of ["0", "0s", "0ms"]) {
      const res = await req("POST", "/workflows", {
        name: "ok",
        source: `name: ok\nsteps:\n  a: {type: llm, prompt: x, timeout: "${t}", next: exit}\n`,
      });
      expect(res.status).toBe(200);
    }
  });

  test("accepts valid timeout strings", async () => {
    for (const t of ["500ms", "30s", "5m", "2h"]) {
      const res = await req("POST", "/workflows", {
        name: "ok",
        source: `name: ok\nsteps:\n  a: {type: llm, prompt: x, timeout: "${t}", next: exit}\n`,
      });
      expect(res.status).toBe(200);
    }
  });

  test("accepts valid numeric max_ms", async () => {
    const res = await req("POST", "/workflows", {
      name: "ok",
      source: `name: ok\nsteps:\n  a: {type: llm, prompt: x, max_ms: 1500, next: exit}\n`,
    });
    expect(res.status).toBe(200);
  });

  test("validator rejects a workflow with unresolved model IDs", async () => {
    // Inject a stub validator — mirrors the daemon wiring. Production
    // uses @fragua/agent's validateWorkflowModels, but @fragua/server
    // stays pi-ai-free.
    const localStore = new SqliteStore({ path: ":memory:" });
    const local = createRoutes({
      store: localStore,
      validateWorkflowModels: (yamlSource) => {
        if (yamlSource.includes("claude-sonnet-4-6")) {
          return {
            ok: false as const,
            offenders: [
              {
                nodeId: "impl",
                provider: "openrouter",
                model: "claude-sonnet-4-6",
                reason: "unknown model",
              },
            ],
          };
        }
        return { ok: true as const };
      },
    });

    const badRes = await local.fetch(
      new Request("http://test/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "bad",
          source: `name: bad\nsteps:\n  impl: {type: llm, prompt: x, model: "claude-sonnet-4-6", provider: "openrouter", next: exit}\n`,
        }),
      }),
    );
    expect(badRes.status).toBe(400);
    const badBody = (await badRes.json()) as {
      code: string;
      offenders: Array<{ nodeId: string; model: string }>;
    };
    expect(badBody.code).toBe("model_unresolved");
    expect(badBody.offenders).toHaveLength(1);
    expect(badBody.offenders[0]?.nodeId).toBe("impl");
    expect(badBody.offenders[0]?.model).toBe("claude-sonnet-4-6");

    // The good path still accepts.
    const goodRes = await local.fetch(
      new Request("http://test/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "good",
          source: "name: good\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
        }),
      }),
    );
    expect(goodRes.status).toBe(200);

    localStore.close();
  });
});

describe("POST /runs — enqueue", () => {
  test("enqueues a run and returns the generated id", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf", priority: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string };
    expect(body.runId).toMatch(/^[0-9a-z]+$/);

    const state = store.getState(body.runId);
    expect(state).not.toBeNull();
    expect(state!.status).toBe("queued");
    expect(state!.priority).toBe(3);
  });

  test("rejects an empty body", async () => {
    const res = await req("POST", "/runs");
    expect(res.status).toBe(400);
  });

  test("rejects unknown workflowSha (CLI upload-then-enqueue path)", async () => {
    const res = await req("POST", "/runs", { workflowSha: "nonexistent" });
    expect(res.status).toBe(400);
  });

  test("rejects enqueue against a stored but unparseable workflow sha", async () => {
    const source = "name: [unterminated\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n";
    const sha = sha256Hex(source);
    const validIr = serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n"));
    store.saveWorkflow(sha, "bad", source, validIr, CURRENT_IR_VERSION);
    const res = await req("POST", "/runs", { workflowSha: sha });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_workflow");
    expect(body.error).toMatch(/workflow/i);
  });

  test("rejects when workflowSha is omitted and workflowName is missing", async () => {
    const res = await req("POST", "/runs", { cwd: "/tmp/p" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/workflowName required/);
  });

  test("rejects when workflowSha is omitted and cwd is missing", async () => {
    const res = await req("POST", "/runs", { workflowName: "change" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/cwd required/);
  });

  test("simple flow: { cwd, workflowName, workflowScope:'local' } resolves via workflowReader", async () => {
    // The web composer ships only the four fields the user types into
    // the form: cwd, workflowName, workflowScope, input. The server
    // reads the latest source off disk, hashes it, registers it, and
    // enqueues — no sha or path travels over the wire. Replaces the
    // earlier sha-pinned flow that mismatched the listing's short sha
    // against the route's full sha and always 400'd.
    const projectCwd = "/projects/alpha";
    const yamlSource = "name: change\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n";
    workflowReader.set("change", yamlSource, { cwd: projectCwd });

    const res = await req("POST", "/runs", {
      cwd: projectCwd,
      workflowName: "change",
      workflowScope: "local",
      input: "rename foo to bar",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string };
    const state = store.getState(body.runId);
    expect(state).not.toBeNull();
    expect(state!.workflowSha).toBe(sha256Hex(yamlSource));
    expect(state!.workflowName).toBe("change");
    expect(state!.cwd).toBe(projectCwd);
    // Server registered the resolved workflow so subsequent runs
    // against the same sha skip the disk read.
    expect(store.getWorkflow(state!.workflowSha)?.name).toBe("change");
  });

  test("rejects simple-flow enqueue when workflowReader returns unparseable source", async () => {
    const source = "name: [unterminated\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n";
    workflowReader.set("bad", source, { cwd: "/projects/alpha" });
    const res = await req("POST", "/runs", {
      cwd: "/projects/alpha",
      workflowName: "bad",
      workflowScope: "local",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_workflow");
    expect(store.getWorkflow(sha256Hex(source))).toBeNull();
  });

  test("simple flow: workflowScope:'global' pins lookup to the global source", async () => {
    const yamlSource = "name: change-global\nsteps:\n  work: {type: llm, prompt: g, next: exit}\n";
    workflowReader.set("change", "name: change-local\nsteps:\n  work: {type: llm, prompt: l, next: exit}\n", {
      cwd: "/projects/alpha",
    });
    workflowReader.set("change", yamlSource); // global

    const res = await req("POST", "/runs", {
      cwd: "/projects/alpha",
      workflowName: "change",
      workflowScope: "global",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string };
    const state = store.getState(body.runId);
    expect(state!.workflowSha).toBe(sha256Hex(yamlSource));
    expect(state!.workflowScope).toBe("global");
  });

  test("input validation: missing required input → 400 invalid_inputs", async () => {
    const src = `name: deploy
inputs:
  ticket:
    type: string
    required: true
steps:
  work: {type: llm, prompt: "fix \${{ inputs.ticket }}", next: exit}
`;
    workflowReader.set("deploy", src, { cwd: "/projects/alpha" });
    const res = await req("POST", "/runs", {
      cwd: "/projects/alpha",
      workflowName: "deploy",
      workflowScope: "local",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_inputs");
    expect(body.error).toMatch(/ticket/);
  });

  test("input validation: bad choice value → 400", async () => {
    const src = `name: deploy
inputs:
  env:
    type: choice
    options: [dev, prod]
steps:
  work: {type: llm, prompt: "deploy \${{ inputs.env }}", next: exit}
`;
    workflowReader.set("deploy", src, { cwd: "/projects/alpha" });
    const res = await req("POST", "/runs", {
      cwd: "/projects/alpha",
      workflowName: "deploy",
      workflowScope: "local",
      inputs: { env: "staging" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_inputs");
  });

  test("input validation: valid inputs → 200 and routing.inputs persisted", async () => {
    const src = `name: deploy
inputs:
  ticket:
    type: string
    required: true
  env:
    type: choice
    options: [dev, prod]
    default: dev
steps:
  work: {type: llm, prompt: "fix \${{ inputs.ticket }} on \${{ inputs.env }}", next: exit}
`;
    workflowReader.set("deploy", src, { cwd: "/projects/alpha" });
    const res = await req("POST", "/runs", {
      cwd: "/projects/alpha",
      workflowName: "deploy",
      workflowScope: "local",
      inputs: { ticket: "BUG-1", env: "prod" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string };
    const state = store.getState(body.runId);
    expect(state!.routing["inputs"]).toEqual({ ticket: "BUG-1", env: "prod" });
  });

  test("simple flow: workflow_not_found when the named workflow isn't on disk", async () => {
    const res = await req("POST", "/runs", {
      cwd: "/projects/alpha",
      workflowName: "missing",
      workflowScope: "local",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("workflow_not_found");
    expect(body.error).toMatch(/missing/);
  });

  test("simple flow: workflow_reader_unavailable when the server has no reader configured", async () => {
    // Bare server (no workflowReader injected) — same as a CI primitive
    // that wires only POST /workflows + POST /runs with sha. The simple
    // flow must surface a typed error rather than 500.
    const bareStore = new SqliteStore({ path: ":memory:" });
    try {
      const bare = createRoutes({ store: bareStore });
      const res = await bare.fetch(
        new Request("http://test/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: "/projects/alpha", workflowName: "change" }),
        }),
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("workflow_reader_unavailable");
    } finally {
      bareStore.close();
    }
  });

  test("body.input is silently ignored (routing.input no longer exists)", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf", input: "rename foo to bar" });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect(state).not.toBeNull();
    expect(state!.routing["input"]).toBeUndefined();
  });

  test("routing passed through body lands on routing (non-input keys preserved)", async () => {
    const res = await req("POST", "/runs", {
      workflowSha: "wf",
      routing: { start_node: "s" },
    });
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect(state!.routing["start_node"]).toBe("s");
    expect(state!.routing["input"]).toBeUndefined();
  });

  test("no input field on enqueue → routing.input is absent", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf" });
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect("input" in state!.routing).toBe(false);
  });

  test("queue-full backpressure: 429 with Retry-After when maxQueuedRuns is met", async () => {
    // Build a fresh server with a small cap so we can drive it past.
    const capped = createRoutes({ store, maxQueuedRuns: 2 });
    const cReq = (method: string, path: string, body?: unknown): Promise<Response> => {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }
      return Promise.resolve(capped.fetch(new Request(`http://test${path}`, init)));
    };

    // Two enqueues fit; the third trips the cap.
    expect((await cReq("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
    expect((await cReq("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
    const overflow = await cReq("POST", "/runs", { workflowSha: "wf" });
    expect(overflow.status).toBe(429);
    expect(overflow.headers.get("Retry-After")).toBe("30");
    const body = (await overflow.json()) as { error: string; code: string };
    expect(body.code).toBe("queue_full");
    expect(body.error).toMatch(/queue full/i);
  });

  test("uncapped server (default) accepts past any threshold", async () => {
    // baseline: same shape as the queue-full test, but without the cap.
    expect((await req("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
    expect((await req("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
    expect((await req("POST", "/runs", { workflowSha: "wf" })).status).toBe(200);
  });

  test("oversized intent payload → 413 with code=payload_too_large (not 500)", async () => {
    // Steer with text that, once JSON-wrapped, exceeds MAX_EVENT_PAYLOAD_BYTES (4 KB).
    // 5000 bytes of "x" plus the wrapper comfortably blows past the cap.
    store.enqueueRun({ runId: "rbig", workflowSha: "wf" });
    const res = await req("POST", "/runs/rbig/steer", { text: "x".repeat(5000) });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; sizeBytes: number; maxBytes: number };
    expect(body.code).toBe("payload_too_large");
    expect(body.sizeBytes).toBeGreaterThan(body.maxBytes);
    expect(body.maxBytes).toBe(4096);
  });

  test("preflightProviders returning ok:false rejects with code=provider_unavailable", async () => {
    const { createRoutes: fresh } = await import("../../src/store/routes.ts");
    const s = new SqliteStore({ path: ":memory:" });
    s.saveWorkflow(
      "wf",
      "t",
      "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
      serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n")),
      CURRENT_IR_VERSION,
    );
    const app = fresh({
      store: s,
      preflightProviders: () => ({ ok: false, detail: "no keys set" }),
    });
    const res = await app.fetch(
      new Request("http://test/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowSha: "wf" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("provider_unavailable");
    expect(body.error).toBe("no keys set");
    s.close();
  });

  test("preflightProviders returning ok:true allows the enqueue through", async () => {
    const { createRoutes: fresh } = await import("../../src/store/routes.ts");
    const s = new SqliteStore({ path: ":memory:" });
    s.saveWorkflow(
      "wf",
      "t",
      "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
      serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n")),
      CURRENT_IR_VERSION,
    );
    const app = fresh({
      store: s,
      preflightProviders: () => ({ ok: true }),
    });
    const res = await app.fetch(
      new Request("http://test/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflowSha: "wf" }),
      }),
    );
    expect(res.status).toBe(200);
    s.close();
  });

  test("no preflightProviders dep → no preflight, enqueue always considered", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf" });
    expect(res.status).toBe(200);
  });

  test("explicit title is stored immediately on the run", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf", title: "My explicit title" });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect(state).not.toBeNull();
    expect(state!.title).toBe("My explicit title");
  });

  test("absent title leaves run.title null (auto-titler path unchanged)", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf" });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect(state).not.toBeNull();
    expect(state!.title).toBeNull();
  });

  test("empty-string title is treated as absent (no title stored)", async () => {
    const res = await req("POST", "/runs", { workflowSha: "wf", title: "" });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    const state = store.getState(runId);
    expect(state!.title).toBeNull();
  });
});

describe("GET /runs/:id/steps", () => {
  test("unknown run → 404 with code=not_found", async () => {
    // Note: this test lives alongside the other /runs/ read tests which
    // mount `createRoutes()` (intent writes + SSE). The steps endpoint is
    // mounted by `storeRunsRoutes`; this test exercises it via a full
    // server wired through createServer(). See steps.test.ts for the
    // pure reducer coverage.
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    const res = await app.request("/runs/unknown/steps");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("not_found");
  });

  test("known run with no llm.start events → 200 with empty array", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "steps-empty", workflowSha: "wf" });
    const res = await app.request("/runs/steps-empty/steps");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("step duration anchors to fact.node_* timestamps, not buffered llm.start", async () => {
    // pi-agent-core flushes llm.start at the end of the call, so its
    // ts is unreliable for wall-clock duration. The reducer anchors
    // each step's `startedAt` to `fact.node_started.ts` (truthful) and
    // its `durationMs` to the next step's startedAt OR — for the last
    // step on a terminal run — the run's last event ts.
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "steps-one", workflowSha: "wf" });
    const s0 = store.getState("steps-one")!;
    store.appendFact(
      "steps-one",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: s0.contractVersion, startNode: "n1" },
        },
      ],
      s0.version,
    );
    const s1 = store.getState("steps-one")!;
    store.appendFact("steps-one", [{ type: "fact.node_started", payload: { nodeId: "n1", iteration: 0 } }], s1.version);
    store.appendObservabilityEvents("steps-one", [{ type: "llm.start", payload: { nodeId: "n1", model: "stub" } }]);
    const s2 = store.getState("steps-one")!;
    store.appendFact("steps-one", [{ type: "fact.run_completed", payload: { finalNode: "n1" } }], s2.version);

    const res = await app.request("/runs/steps-one/steps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ nodeId: string; model?: string; durationMs?: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.nodeId).toBe("n1");
    expect(body[0]!.model).toBe("stub");
    // Last step on a terminal run gets a durationMs from the run's
    // last event ts.
    expect(typeof body[0]!.durationMs).toBe("number");
    expect(body[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /runs?status= filter", () => {
  test("accepts paused_auto — regression: VALID_STATUSES used to drop the literal", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "ppr-1", workflowSha: "wf" });
    const s0 = store.getState("ppr-1")!;
    store.appendFact(
      "ppr-1",
      [
        {
          type: "fact.run_paused",
          payload: {
            reason: "provider_retry",
            nodeId: "n1",
            httpStatus: 503,
            provider: "anthropic",
            errorMessage: "503 service unavailable",
            attempt: 1,
            resumeAt: Date.now() + 60_000,
          },
        },
      ],
      s0.version,
    );
    expect(store.getState("ppr-1")!.status).toBe("paused_auto");

    const res = await app.request("/runs?status=paused_auto");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ runId: string; status: string }>;
    expect(body.some((r) => r.runId === "ppr-1")).toBe(true);

    // Control: mixing in an unknown token must still surface the run
    // (proves `paused_auto` is in the allow-list, not just tolerated
    // by an empty filter).
    const res2 = await app.request("/runs?status=paused_auto,bogus");
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as Array<{ runId: string }>;
    expect(body2.some((r) => r.runId === "ppr-1")).toBe(true);
  });

  test("?status= filter accepts every RunStatus literal", async () => {
    // Enum-literal consumer rule (ground rule 1): VALID_STATUSES is derived
    // from RUN_STATUSES, so this drives one run into each lifecycle status
    // and proves the filter round-trips every literal end to end — a literal
    // dropped by the allow-list would return an empty (or wrong) result set.
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });

    const start = (runId: string) => {
      store.enqueueRun({ runId, workflowSha: "wf" });
      const s = store.getState(runId)!;
      store.appendFact(
        runId,
        [
          {
            type: "fact.run_started",
            payload: { workflowSha: "wf", contractVersion: s.contractVersion, startNode: "n1" },
          },
        ],
        s.version,
      );
    };
    const fact = (runId: string, f: Parameters<typeof store.appendFact>[1][number]) => {
      store.appendFact(runId, [f], store.getState(runId)!.version);
    };

    store.enqueueRun({ runId: "st-queued", workflowSha: "wf" });
    start("st-running");
    start("st-paused");
    fact("st-paused", { type: "fact.run_paused", payload: { reason: "operator", nodeId: "n1" } });
    start("st-paused_human");
    fact("st-paused_human", { type: "fact.run_paused_human", payload: { nodeId: "n1", text: "?", routes: ["a"] } });
    start("st-paused_auto");
    fact("st-paused_auto", {
      type: "fact.run_paused",
      payload: {
        reason: "provider_retry",
        nodeId: "n1",
        httpStatus: 503,
        provider: "anthropic",
        errorMessage: "503",
        attempt: 1,
        resumeAt: Date.now() + 60_000,
      },
    });
    start("st-completed");
    fact("st-completed", { type: "fact.run_completed", payload: { finalNode: "n1" } });
    start("st-cancelled");
    fact("st-cancelled", { type: "fact.run_cancelled", payload: { intentSeq: 1 } });
    start("st-halted");
    fact("st-halted", { type: "fact.run_halted", payload: { reason: "error" } });
    start("st-quarantined");
    fact("st-quarantined", { type: "fact.run_quarantined", payload: { reason: "other" } });

    for (const status of RUN_STATUSES) {
      expect(store.getState(`st-${status}`)!.status).toBe(status);
      const res = await app.request(`/runs?status=${status}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ runId: string }>;
      // Exactly the one run in that status — a literal dropped by the
      // allow-list would yield [] here; a leaky filter would yield extras.
      // (The wire `status` field is a display status, so compare by runId.)
      expect(
        body.map((r) => r.runId),
        `?status=${status} drifted — a RunStatus literal is being dropped or leaked by the filter`,
      ).toEqual([`st-${status}`]);
    }
  });
});

describe("GET /runs/:id/messages", () => {
  test("unknown run → 404 with code=not_found", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    const res = await app.request("/runs/missing/messages");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("not_found");
  });

  test("returns appended messages as AgentMessage JSON", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "msgs-one", workflowSha: "wf" });
    store.appendMessage("msgs-one", {
      content: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      nodeId: "n1",
      iteration: 0,
    });
    const res = await app.request("/runs/msgs-one/messages");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      content: { role: string; content: Array<{ type: string; text: string }> };
      nodeId: string | null;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.content.role).toBe("user");
    expect(body[0]!.content.content[0]).toMatchObject({ type: "text", text: "hello" });
  });

  test("filters by nodeId + sinceOrdinal", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "msgs-filter", workflowSha: "wf" });
    store.appendMessage("msgs-filter", {
      content: { role: "user", content: [{ type: "text", text: "one" }], timestamp: 1 },
      nodeId: "a",
      iteration: 0,
    });
    store.appendMessage("msgs-filter", {
      content: { role: "user", content: [{ type: "text", text: "two" }], timestamp: 2 },
      nodeId: "a",
      iteration: 0,
    });
    store.appendMessage("msgs-filter", {
      content: { role: "user", content: [{ type: "text", text: "three" }], timestamp: 3 },
      nodeId: "b",
      iteration: 0,
    });

    const byNodeRes = await app.request("/runs/msgs-filter/messages?nodeId=a");
    const byNode = (await byNodeRes.json()) as Array<{ content: { content: Array<{ text: string }> } }>;
    expect(byNode.map((m) => m.content.content[0]?.text)).toEqual(["one", "two"]);

    const sinceRes = await app.request("/runs/msgs-filter/messages?sinceOrdinal=1");
    const sinceOne = (await sinceRes.json()) as Array<{ ordinal: number }>;
    expect(sinceOne.map((m) => m.ordinal)).toEqual([2, 3]);
  });
});

describe("intent-write routes", () => {
  test.each([
    ["steer", "/steer", { text: "go" }, "intent.steering_requested"],
    ["pause", "/pause", undefined, "intent.pause_requested"],
    ["cancel", "/cancel", { reason: "stop" }, "intent.cancel_requested"],
    ["resume", "/resume", { note: "topped up" }, "intent.resume"],
    ["resume-noargs", "/resume", undefined, "intent.resume"],
    ["unquarantine", "/unquarantine", { resolution: "retry", note: "try again" }, "intent.unquarantine"],
    ["priority", "/priority", { newPriority: 5 }, "intent.priority_adjusted"],
  ] as const)("POST /runs/:id/%s writes an %s intent", async (_label, path, body, type) => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    const res = await req("POST", `/runs/r${path}`, body);
    expect(res.status).toBe(200);
    const events = store.getEvents("r");
    expect(events.some((e) => e.type === type)).toBe(true);
  });

  test("POST /runs/:id/human writes an intent.human_input intent when route is in the declared enum", async () => {
    // Phase 7 of llm-routing.md adds server-side enum validation:
    // the endpoint reads the latest fact.run_paused_human payload to
    // recover the declared routes and rejects off-list routes with
    // 400. Setup: enqueue + pause with routes=["A","B"], then POST
    // route="A" (in-enum, should succeed) and route="C" (off-list,
    // should 400).
    store.enqueueRun({ runId: "rh", workflowSha: "wf" });
    const state = store.getState("rh")!;
    store.appendFact(
      "rh",
      [{ type: "fact.run_paused_human", payload: { nodeId: "ask", text: "?", routes: ["A", "B"] } }],
      state.version,
    );

    const ok = await req("POST", "/runs/rh/human", { route: "A" });
    expect(ok.status).toBe(200);
    const events = store.getEvents("rh");
    expect(events.some((e) => e.type === "intent.human_input")).toBe(true);
  });

  test("POST /runs/:id/human rejects an off-enum route with 400 and a descriptive error", async () => {
    store.enqueueRun({ runId: "rh2", workflowSha: "wf" });
    const state = store.getState("rh2")!;
    store.appendFact(
      "rh2",
      [{ type: "fact.run_paused_human", payload: { nodeId: "ask", text: "?", routes: ["approve", "reject"] } }],
      state.version,
    );

    const bad = await req("POST", "/runs/rh2/human", { route: "ship" });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string };
    expect(body.error).toMatch(/unknown route "ship"/);
    expect(body.error).toMatch(/approve, reject/);
  });

  test("POST /runs/:id/human accepts any route but warns when the pause fact declares no routes", async () => {
    // Fail-open path: an older fact.run_paused_human shape (routes: []) means
    // the enum check is skipped. The input is still accepted (compat), but the
    // skip must surface as a structured warning carrying run id + route.
    store.enqueueRun({ runId: "rh4", workflowSha: "wf" });
    const state = store.getState("rh4")!;
    store.appendFact(
      "rh4",
      [{ type: "fact.run_paused_human", payload: { nodeId: "ask", text: "?", routes: [] } }],
      state.version,
    );

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await req("POST", "/runs/rh4/human", { route: "anything" });
      expect(res.status).toBe(200);
      const events = store.getEvents("rh4");
      expect(events.some((e) => e.type === "intent.human_input")).toBe(true);

      const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(warned).toContain("without route validation");
      expect(warned).toContain("rh4");
      expect(warned).toContain('route="anything"');
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("POST /runs/:id/human returns 409 when the run is not paused at a human node", async () => {
    store.enqueueRun({ runId: "rh3", workflowSha: "wf" });
    const res = await req("POST", "/runs/rh3/human", { route: "A" });
    expect(res.status).toBe(409);
  });

  test("POST /runs/:id/steer rejects empty text", async () => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    const res = await req("POST", "/runs/r/steer", { text: "" });
    expect(res.status).toBe(400);
  });

  test("POST /runs/:id/unquarantine rejects bad resolution", async () => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    const res = await req("POST", "/runs/r/unquarantine", {
      resolution: "bogus",
    });
    expect(res.status).toBe(400);
  });
});

describe("reads", () => {
  test("GET /runs/:id/events supports since= filter", async () => {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    store.appendIntent("r", { type: "intent.pause_requested", payload: {} });
    store.appendIntent("r", {
      type: "intent.steering_requested",
      payload: { text: "hi" },
    });

    const all = (await (await req("GET", "/runs/r/events")).json()) as {
      seq: number;
    }[];
    const after1 = (await (await req("GET", "/runs/r/events?since=1")).json()) as { seq: number }[];
    expect(all).toHaveLength(3);
    expect(after1).toHaveLength(2);
    expect(after1[0]!.seq).toBeGreaterThan(1);
  });
});

describe("GET /metrics/global", () => {
  test("sums generated columns + pivots model breakdown", async () => {
    store.enqueueRun({ runId: "r1", workflowSha: "wf" });
    const s = store.getState("r1")!;
    store.appendFact(
      "r1",
      [
        {
          type: "fact.run_started",
          payload: {
            workflowSha: "wf",
            contractVersion: s.contractVersion,
            startNode: "a",
          },
        },
      ],
      s.version,
    );
    const s1 = store.getState("r1")!;
    store.appendFact(
      "r1",
      [
        {
          type: "fact.node_completed",
          payload: {
            nodeId: "a",
            iteration: 0,
            tokens: 100,
            costUsd: 0.02,
            modelName: "gemini-1.5-pro",
            nextNode: "__end__",
          },
        },
        { type: "fact.run_completed", payload: { finalNode: "__end__" } },
      ],
      s1.version,
    );

    const res = await req("GET", "/metrics/global");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total_runs: number;
      total_usd: number;
      billed_tokens: number;
      successful: number;
      breakdownByModel: { model_name: string; tokens: number; cost_usd: number }[];
    };
    expect(body.total_runs).toBe(1);
    expect(body.billed_tokens).toBe(100);
    expect(body.total_usd).toBeCloseTo(0.02, 6);
    expect(body.successful).toBe(1);
    const pro = body.breakdownByModel.find((r) => r.model_name === "gemini-1.5-pro");
    expect(pro).toBeDefined();
    expect(pro!.tokens).toBe(100);
    expect(pro!.cost_usd).toBeCloseTo(0.02, 6);
  });
});

describe("P19 — SSE replay via Last-Event-ID", () => {
  /** Seed `r` with four intents, producing events at seq 1..4 (the
   * enqueue is seq 1; each appendIntent adds one more). Returned for
   * tests that want to assert which subset crosses the wire. */
  function seedFourIntents(): void {
    store.enqueueRun({ runId: "r", workflowSha: "wf" });
    store.appendIntent("r", { type: "intent.pause_requested", payload: {} });
    store.appendIntent("r", { type: "intent.steering_requested", payload: { text: "go" } });
    store.appendIntent("r", { type: "intent.cancel_requested", payload: { reason: "stop" } });
  }

  /** Drain the SSE response into a single string, capped at the deadline
   * or once `marker` appears (whichever first). Marker keeps the loop
   * tight when we know which final id: should land. */
  async function drainSSE(res: Response, marker: string, timeoutMs = 500): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += decoder.decode(value, { stream: true });
      if (chunks.includes(marker)) break;
    }
    await reader.cancel();
    return chunks;
  }

  test("reconnect with Last-Event-ID=N delivers only events with seq > N", async () => {
    seedFourIntents();

    const routes = createRoutes({ store, ssePollMs: 10 });
    const res = await routes.fetch(
      new Request("http://test/runs/r/stream", {
        headers: { "Last-Event-ID": "2" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);

    const chunks = await drainSSE(res, "id: 4");

    // Stream must contain seq 3 and 4, and NOT seq 1 or 2.
    expect(chunks).toContain("id: 3");
    expect(chunks).toContain("id: 4");
    expect(chunks).not.toContain("id: 1\n");
    expect(chunks).not.toContain("id: 2\n");
  });

  test("initial connect with ?sinceSeq=N delivers only events with seq > N", async () => {
    // Pin the initial-connect path independently of Last-Event-ID. This
    // is the cursor `useRunLive` actually puts on the URL when opening
    // the EventSource for the first time (it knows from the snapshot
    // it's caught up to lastEventSeq).
    seedFourIntents();

    const routes = createRoutes({ store, ssePollMs: 10 });
    const res = await routes.fetch(new Request("http://test/runs/r/stream?sinceSeq=2"));
    expect(res.status).toBe(200);

    const chunks = await drainSSE(res, "id: 4");

    expect(chunks).toContain("id: 3");
    expect(chunks).toContain("id: 4");
    expect(chunks).not.toContain("id: 1\n");
    expect(chunks).not.toContain("id: 2\n");
  });

  test("reconnect with stale ?sinceSeq=N + Last-Event-ID=M (M > N) uses max() — no duplicate replay", async () => {
    // The auto-reconnect path. The URL still carries ?sinceSeq=<snapshot>
    // baked at initial connect, but the browser sets Last-Event-ID to the
    // last id: it actually received — which is strictly ahead of the
    // snapshot cursor by the time a reconnect fires. Server must take
    // max() so the client doesn't re-fold events 3..M into liveCost.
    seedFourIntents();

    const routes = createRoutes({ store, ssePollMs: 10 });
    const res = await routes.fetch(
      new Request("http://test/runs/r/stream?sinceSeq=1", {
        headers: { "Last-Event-ID": "3" },
      }),
    );
    expect(res.status).toBe(200);

    const chunks = await drainSSE(res, "id: 4");

    // max(1, 3) = 3 → only seq 4 should land. Seqs 2 and 3 (between the
    // stale query cursor and the up-to-date header) MUST NOT replay.
    expect(chunks).toContain("id: 4");
    expect(chunks).not.toContain("id: 1\n");
    expect(chunks).not.toContain("id: 2\n");
    expect(chunks).not.toContain("id: 3\n");
  });

  test("?sinceSeq=N + Last-Event-ID=M (N > M) still uses max() — symmetric edge", async () => {
    // The opposite ordering can't happen on real reconnects (Last-Event-ID
    // monotonically grows) but a malformed / replayed request shouldn't
    // be able to trick the server into re-streaming earlier events.
    seedFourIntents();

    const routes = createRoutes({ store, ssePollMs: 10 });
    const res = await routes.fetch(
      new Request("http://test/runs/r/stream?sinceSeq=3", {
        headers: { "Last-Event-ID": "1" },
      }),
    );
    expect(res.status).toBe(200);

    const chunks = await drainSSE(res, "id: 4");

    expect(chunks).toContain("id: 4");
    expect(chunks).not.toContain("id: 1\n");
    expect(chunks).not.toContain("id: 2\n");
    expect(chunks).not.toContain("id: 3\n");
  });

  test("/runs/:id/stream drains all events before closing on a terminal run", async () => {
    // Regression: the loop used to check terminal *after every batch*,
    // so a completed run with > batchSize events sent only the first
    // batch and returned, dropping everything past it. Browser opening
    // the conversation page on a terminal run would then see liveCost
    // / message buffers with chunks missing.
    store.enqueueRun({ runId: "long", workflowSha: "wf" });
    const s0 = store.getState("long")!;
    store.appendFact(
      "long",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: s0.contractVersion, startNode: "a" },
        },
      ],
      s0.version,
    );
    // Emit 12 cost.recorded events, well past a tiny batchSize of 3.
    // We use a non-fact event type so we don't perturb projection state.
    const obs = Array.from({ length: 12 }, () => ({
      type: "cost.recorded" as const,
      payload: { cost_usd: 0.001, total_tokens: 10, nodeId: "a" } as Record<string, unknown>,
    }));
    store.appendObservabilityEvents("long", obs);
    const s1 = store.getState("long")!;
    store.appendFact("long", [{ type: "fact.run_completed", payload: { finalNode: "a" } }], s1.version);

    const routes = createRoutes({ store, ssePollMs: 10, sseBatchSize: 3 });
    const res = await routes.fetch(new Request("http://test/runs/long/stream"));
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    let closed = false;
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
      chunks += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    // Stream closed cleanly (terminal exit path fired).
    expect(closed).toBe(true);
    // All 12 cost.recorded events delivered, not just the first batchSize=3.
    const costMatches = chunks.match(/"type":"cost\.recorded"/g) ?? [];
    expect(costMatches.length).toBe(12);
    // Terminal fact made it through too.
    expect(chunks).toContain("fact.run_completed");
  });

  test("/runs/:id/stream closes on its own once the run reaches a terminal status", async () => {
    // Without this close, the loop would poll forever after the run
    // ended, and the browser's EventSource would auto-reconnect on every
    // proxy/idle drop. The handler must return after the last batch
    // that includes a terminal fact.
    store.enqueueRun({ runId: "term", workflowSha: "wf" });
    const s0 = store.getState("term")!;
    store.appendFact(
      "term",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: s0.contractVersion, startNode: "a" },
        },
      ],
      s0.version,
    );
    const s1 = store.getState("term")!;
    store.appendFact("term", [{ type: "fact.run_completed", payload: { finalNode: "a" } }], s1.version);

    const routes = createRoutes({ store, ssePollMs: 10 });
    const res = await routes.fetch(new Request("http://test/runs/term/stream"));
    expect(res.status).toBe(200);

    // Drain the response — if the close fires correctly, `reader.read()`
    // resolves with `done: true` quickly. If it doesn't, the test times
    // out at the deadline (which would also fail the assertion below).
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    let closed = false;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) {
        closed = true;
        break;
      }
      chunks += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => {});

    expect(closed).toBe(true);
    expect(chunks).toContain("fact.run_completed");
  });
});

describe("global event feed (cross-run)", () => {
  /** Drain SSE response into a single string, capped at deadline or
   * once `marker` appears. Mirrors the per-run helper above; private
   * here so each describe block has its own. */
  async function drainSSE(res: Response, marker: string, timeoutMs = 500): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let chunks = "";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks += decoder.decode(value, { stream: true });
      if (chunks.includes(marker)) break;
    }
    await reader.cancel().catch(() => {});
    return chunks;
  }

  /** Seed two runs with a mix of allow-listed and excluded events:
   *   - a, b: fact.run_started / fact.run_completed (allow-listed)
   *   - a:    fact.node_started, fact.node_completed (excluded)
   *   - a:    cost.recorded (excluded — observability)
   * `enqueueRun` lands `intent.run_enqueued` (seq 1) but that's not in
   * `FEED_EVENT_KINDS` — the feed is facts-only.
   */
  function seedTwoRuns(): void {
    store.enqueueRun({ runId: "a", workflowSha: "wf" });
    const a0 = store.getState("a")!;
    const a1 = store.appendFact(
      "a",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: a0.contractVersion, startNode: "n" },
        },
      ],
      a0.version,
    );
    store.appendFact("a", [{ type: "fact.node_started", payload: { nodeId: "n", iteration: 1 } }], a1.newVersion);
    store.appendObservabilityEvents("a", [
      { type: "cost.recorded", payload: { cost_usd: 0.001, total_tokens: 5, nodeId: "n" } },
    ]);

    store.enqueueRun({ runId: "b", workflowSha: "wf" });
    const b0 = store.getState("b")!;
    const b1 = store.appendFact(
      "b",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: b0.contractVersion, startNode: "n" },
        },
      ],
      b0.version,
    );
    store.appendFact("b", [{ type: "fact.run_completed", payload: { finalNode: "n" } }], b1.newVersion);
  }

  test("GET /events returns allow-listed events oldest-first, excluding node + observability", async () => {
    seedTwoRuns();
    const routes = createRoutes({ store });
    const res = await routes.fetch(new Request("http://test/events"));
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<{ type: string; runId: string; ts: number; seq: number }>;

    const types = events.map((e) => e.type);
    // Allow-listed kinds present
    expect(types).toContain("fact.run_started");
    expect(types).toContain("fact.run_completed");
    // Excluded kinds absent — node-level facts, observability, and the
    // seq-1 enqueue intent are filtered out (facts-only feed).
    expect(types).not.toContain("intent.run_enqueued");
    expect(types).not.toContain("fact.node_started");
    expect(types).not.toContain("cost.recorded");

    // Oldest-first ordering by (ts, runId, seq) tuple
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!;
      const cur = events[i]!;
      const prevKey = [prev.ts, prev.runId, prev.seq] as const;
      const curKey = [cur.ts, cur.runId, cur.seq] as const;
      expect(prevKey <= curKey).toBe(true);
    }
  });

  test("GET /events?limit=N caps the response", async () => {
    seedTwoRuns();
    const routes = createRoutes({ store });
    const res = await routes.fetch(new Request("http://test/events?limit=2"));
    const events = (await res.json()) as unknown[];
    expect(events.length).toBe(2);
  });

  test("GET /events/stream delivers live allow-listed events across runs", async () => {
    // Pre-seed run a + b with run_started, then open the stream and append
    // a fact.run_completed on each. The stream should pick up both.
    seedTwoRuns();
    const routes = createRoutes({ store, ssePollMs: 10 });

    // Find the most-recent existing event so we can resume after it and
    // only see new appends — avoids racing on whether the loop drains
    // the seed before our follow-up appends land.
    const seedRes = await routes.fetch(new Request("http://test/events?limit=200"));
    const seedEvents = (await seedRes.json()) as Array<{ ts: number; runId: string; seq: number }>;
    const cursor = seedEvents[seedEvents.length - 1]!;

    const streamRes = await routes.fetch(
      new Request(
        // `?fromTs=cursor.ts` (not `+1`) matches the new `>=` semantics —
        // seed events at cursor.ts may be re-delivered (server has no
        // memory of what the prior connection saw); the test only
        // asserts on the *new* events, which is the correctness bar.
        `http://test/events/stream?fromTs=${cursor.ts}`,
      ),
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toMatch(/event-stream/);

    // Now append a halt on `a` (allow-listed) and a node_aborted on `a`
    // (excluded). The stream should see only the halt.
    const aState = store.getState("a")!;
    store.appendFact("a", [{ type: "fact.run_halted", payload: { reason: "error" } }], aState.version);
    const aState2 = store.getState("a")!;
    // node_aborted on a non-running run would fail OCC; use cost.recorded
    // (observability, doesn't bump version) to inject an excluded kind.
    store.appendObservabilityEvents("a", [{ type: "agent.warning", payload: { message: "noise" } }]);
    // And a real allow-listed event on `b`. The reducer is permissive
    // about logical transitions (b is at `completed`); the OCC version
    // bump is what we care about here, and the SSE filter only inspects
    // event type. `quarantined` is unique to b in this test, so it makes
    // an unambiguous SSE marker.
    const bState = store.getState("b")!;
    store.appendFact("b", [{ type: "fact.run_quarantined", payload: { reason: "other" } }], bState.version);

    const chunks = await drainSSE(streamRes, "fact.run_quarantined");

    expect(chunks).toContain("fact.run_halted");
    expect(chunks).toContain("fact.run_quarantined");
    // Excluded kinds must not appear, even though they share the same
    // events table.
    expect(chunks).not.toContain("agent.warning");
    expect(chunks).not.toContain("cost.recorded");

    void aState2;
  });

  /** Enqueue a run and append `fact.run_started` so the run produces
   *  at least one event in `FEED_EVENT_KINDS` (the enqueue intent isn't
   *  in the facts-only feed). Both events land at the current `now`. */
  function enqueueWithStart(s: SqliteStore, runId: string, workflowSha: string): void {
    s.enqueueRun({ runId, workflowSha });
    const st = s.getState(runId)!;
    s.appendFact(
      runId,
      [{ type: "fact.run_started", payload: { workflowSha, contractVersion: st.contractVersion, startNode: "n" } }],
      st.version,
    );
  }

  test("GET /events/stream resume via Last-Event-ID skips events with ts < cursor.ts", async () => {
    // The server filter is `ts >= cursor.ts`, deliberately — strict
    // tuple-greater would silently drop same-ms appends to lex-smaller
    // run_ids (the live-tail bug client-side dedup is built to absorb).
    // So this test pins the contract that a newer Last-Event-ID skips
    // strictly older events; cursor-ts events may be re-delivered (the
    // client dedupes locally via the SSE id triple).
    //
    // Build two ts windows by inserting events under controlled `now`.
    let nowVal = 1_000_000;
    const tStore = new SqliteStore({ path: ":memory:", now: () => nowVal });
    try {
      tStore.saveWorkflow(
        "wf",
        "t",
        "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
        serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n")),
        CURRENT_IR_VERSION,
      );
      // Window 1 @ ts=1_000_000
      enqueueWithStart(tStore, "r1", "wf");
      // Window 2 @ ts=1_000_500 (500 ms later)
      nowVal = 1_000_500;
      enqueueWithStart(tStore, "r2", "wf");

      const tRoutes = createRoutes({ store: tStore, ssePollMs: 10 });
      // Cursor at end of window 1 — its events should NOT cross the
      // wire because their ts < cursor.ts. Window-2 events (ts >=) do.
      const cursorTs = 1_000_500; // start of window 2
      const res = await tRoutes.fetch(
        new Request("http://test/events/stream", {
          headers: { "Last-Event-ID": `${cursorTs}.r2.0` },
        }),
      );
      const chunks = await drainSSE(res, "r2");

      // Window 2 lands.
      expect(chunks).toContain('"runId":"r2"');
      // Window 1 (ts=1_000_000 < cursor) is filtered out by `ts >=`.
      expect(chunks).not.toContain('"runId":"r1"');
    } finally {
      tStore.close();
    }
  });

  test("GET /events/stream uses max(?fromTs, Last-Event-ID.ts) on reconnect", async () => {
    // The cursor on the wire is just `ts` (with the full triple in the
    // SSE id for client-side dedup). On reconnect, the original
    // `?fromTs=` baked at first connect is stale; `Last-Event-ID.ts`
    // is fresh. Server picks whichever is larger so the older query
    // cursor doesn't replay events the client already saw.
    let nowVal = 2_000_000;
    const tStore = new SqliteStore({ path: ":memory:", now: () => nowVal });
    try {
      tStore.saveWorkflow(
        "wf",
        "t",
        "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
        serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n")),
        CURRENT_IR_VERSION,
      );
      // ts windows: 2_000_000, 2_000_100, 2_000_200
      enqueueWithStart(tStore, "r1", "wf");
      nowVal = 2_000_100;
      enqueueWithStart(tStore, "r2", "wf");
      nowVal = 2_000_200;
      enqueueWithStart(tStore, "r3", "wf");

      const tRoutes = createRoutes({ store: tStore, ssePollMs: 10 });
      const stale = 2_000_000; // baked-in query cursor
      const fresh = 2_000_200; // browser's last-received ts
      const url = `http://test/events/stream?fromTs=${stale}`;
      const res = await tRoutes.fetch(
        new Request(url, {
          headers: { "Last-Event-ID": `${fresh}.r3.0` },
        }),
      );
      const chunks = await drainSSE(res, "r3");

      // Only the fresh-window event lands (ts >= 2_000_200). Older
      // windows (r1@2_000_000, r2@2_000_100) MUST NOT replay despite
      // the staler ?fromTs=.
      expect(chunks).toContain('"runId":"r3"');
      expect(chunks).not.toContain('"runId":"r1"');
      expect(chunks).not.toContain('"runId":"r2"');
    } finally {
      tStore.close();
    }
  });

  test("GET /events/stream — same-ms append to a lex-smaller run_id still reaches the live tail", async () => {
    // Regression for the cursor design: with strict-greater on a
    // `(ts, run_id, seq)` tuple, a new event landing at the cursor's
    // ts but with a run_id that lex-sorts BEFORE the cursor's run_id
    // would silently fall "before" the cursor and never reach the
    // client. The current design uses `ts >= cursor.ts` + per-
    // connection dedup specifically to absorb this case.
    //
    // Pin both runs to the same `now` so every event shares ts.
    const nowVal = 5_000_000;
    const tStore = new SqliteStore({ path: ":memory:", now: () => nowVal });
    try {
      tStore.saveWorkflow(
        "wf",
        "t",
        "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
        serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n")),
        CURRENT_IR_VERSION,
      );
      // Seed run "z" first, then take its last delivered event as the cursor.
      enqueueWithStart(tStore, "z", "wf");
      const tRoutes = createRoutes({ store: tStore, ssePollMs: 10 });

      // Cursor = (ts, "z", 2) — z's run_started fact (seq 1 is the
      // enqueue intent, which the facts-only feed filter excludes).
      const cursorId = `${nowVal}.z.2`;
      const res = await tRoutes.fetch(
        new Request("http://test/events/stream", {
          headers: { "Last-Event-ID": cursorId },
        }),
      );

      // Now append a new run "a" — same ts, lex-smaller run_id. With
      // a strict-greater tuple cursor this would be filtered.
      enqueueWithStart(tStore, "a", "wf");

      const chunks = await drainSSE(res, '"runId":"a"');
      expect(chunks).toContain('"runId":"a"');
      // SSE id matches the (ts, runId, seq) of a's run_started fact.
      expect(chunks).toContain(`id: ${nowVal}.a.2\n`);
    } finally {
      tStore.close();
    }
  });

  test("GET /events/stream — full batch of same-ms events does not stall", async () => {
    // Same-ms write burst: 8 runs enqueued at the same pinned now,
    // batchSize forced to 3 so the SSE handler must paginate through
    // them across multiple iterations. The forward strict-tuple cursor
    // advances on each emission so every event reaches the wire.
    const nowVal = 12_000_000;
    const tStore = new SqliteStore({ path: ":memory:", now: () => nowVal });
    try {
      tStore.saveWorkflow(
        "wf",
        "t",
        "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n",
        serializeGraph(parseWorkflow("name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n")),
        CURRENT_IR_VERSION,
      );
      const runIds = ["r01", "r02", "r03", "r04", "r05", "r06", "r07", "r08"];
      for (const rid of runIds) enqueueWithStart(tStore, rid, "wf");

      const tRoutes = createRoutes({ store: tStore, ssePollMs: 5, sseBatchSize: 3 });
      const res = await tRoutes.fetch(new Request("http://test/events/stream"));

      const chunks = await drainSSE(res, '"runId":"r08"');
      for (const rid of runIds) {
        expect(chunks).toContain(`"runId":"${rid}"`);
      }
    } finally {
      tStore.close();
    }
  });

  test("GET /events/stream stays open across runs (no terminal close)", async () => {
    // Seed a single completed run; the per-run stream would close, the
    // global stream must not — terminality is a per-run concept.
    store.enqueueRun({ runId: "done", workflowSha: "wf" });
    const s0 = store.getState("done")!;
    const s1 = store.appendFact(
      "done",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: s0.contractVersion, startNode: "n" },
        },
      ],
      s0.version,
    );
    store.appendFact("done", [{ type: "fact.run_completed", payload: { finalNode: "n" } }], s1.newVersion);

    const routes = createRoutes({ store, ssePollMs: 10 });
    const res = await routes.fetch(new Request("http://test/events/stream"));

    // Drain until both lifecycle events arrive, then cancel. The stream
    // must NOT close on its own (per-run terminality doesn't apply); the
    // post-cancel state is the assertion.
    const chunks = await drainSSE(res, "fact.run_completed");
    expect(chunks).toContain("fact.run_started");
    expect(chunks).toContain("fact.run_completed");
    // If `shouldClose` had fired the way per-run streams do, drainSSE
    // would have hit `done: true` before its 500ms deadline. The fact
    // that we reached the marker means the loop kept running past
    // terminal — exactly the contract we want.
  });

  test("GET /events surfaces operator-action facts and strips remaining bookkeeping kinds", async () => {
    // Seed run "c" with: one lifecycle anchor (run_started), all four
    // operator-action facts now in FEED_EVENT_KINDS, and fact.message_appended
    // which must still be stripped (never in the allowlist).
    store.enqueueRun({ runId: "c", workflowSha: "wf" });
    const c0 = store.getState("c")!;
    const c1 = store.appendFact(
      "c",
      [
        {
          type: "fact.run_started",
          payload: { workflowSha: "wf", contractVersion: c0.contractVersion, startNode: "n" },
        },
      ],
      c0.version,
    );
    // Operator-action facts — now in FEED_EVENT_KINDS, must appear in the feed.
    const c2 = store.appendFact(
      "c",
      [{ type: "fact.run_accepted", payload: { sha: "tip1", replayed: 1, tailStaged: false } }],
      c1.newVersion,
    );
    const c5 = store.appendFact(
      "c",
      [{ type: "fact.run_discarded", payload: { refs: ["refs/fragua/snapshots/c"] } }],
      c2.newVersion,
    );
    // fact.message_appended is still a bookkeeping kind — must stay stripped.
    store.appendFact(
      "c",
      [{ type: "fact.message_appended", payload: { ordinal: 0, role: "assistant", nodeId: null, iteration: 1 } }],
      c5.newVersion,
    );

    const routes = createRoutes({ store });
    const res = await routes.fetch(new Request("http://test/events"));
    expect(res.status).toBe(200);
    const events = (await res.json()) as Array<{ type: string }>;
    const types = events.map((e) => e.type);

    // Lifecycle anchor present.
    expect(types).toContain("fact.run_started");
    // Operator-action facts must now appear in the feed.
    expect(types).toContain("fact.run_accepted");
    expect(types).toContain("fact.run_discarded");
    // message_appended still stripped.
    expect(types).not.toContain("fact.message_appended");
    // Every returned type must be in the FEED_EVENT_KINDS allowlist.
    const allowed = new Set<string>(FEED_EVENT_KINDS);
    for (const t of types) {
      expect(allowed.has(t)).toBe(true);
    }
  });
});

describe("GET /projects + GET /runs?project_id= — project surface", () => {
  test("/projects returns one row per project_id with name + cwd hint + counts", async () => {
    // Same id from two cwds (clone/import) folds into one project; the hint
    // is the most-recent cwd.
    store.enqueueRun({
      runId: "a1",
      workflowSha: "wf",
      cwd: "/box/alpha",
      projectId: "proj-alpha",
      projectName: "alpha",
    });
    store.enqueueRun({
      runId: "a2",
      workflowSha: "wf",
      cwd: "/box2/alpha",
      projectId: "proj-alpha",
      projectName: "alpha",
    });
    store.enqueueRun({ runId: "b1", workflowSha: "wf", cwd: "/box/beta", projectId: "proj-beta", projectName: "beta" });
    const res = await req("GET", "/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ projectId: string; name: string; cwd: string | null; runCount: number }>;
    expect(body.map((r) => r.projectId).sort()).toEqual(["proj-alpha", "proj-beta"]);
    const alpha = body.find((r) => r.projectId === "proj-alpha");
    expect(alpha?.name).toBe("alpha");
    expect(alpha?.runCount).toBe(2);
    // cwd hint is a representative recent checkout; either folds-in cwd is valid
    // (same-ms enqueues tie on updated_at).
    expect(["/box/alpha", "/box2/alpha"]).toContain(alpha?.cwd);
  });

  test("/projects surfaces an imported-only project (no local cwd) with a null hint", async () => {
    store.enqueueRun({ runId: "imp", workflowSha: "wf", projectId: "proj-imported", projectName: "web" });
    const res = await req("GET", "/projects");
    const body = (await res.json()) as Array<{ projectId: string; name: string; cwd: string | null }>;
    const imp = body.find((r) => r.projectId === "proj-imported");
    expect(imp?.name).toBe("web");
    expect(imp?.cwd).toBeNull();
  });

  test("/runs?project_id=… filters by identity (served by storeRunsRoutes)", async () => {
    const { createServer } = await import("../../src/index.ts");
    const app = createServer({ store });
    store.enqueueRun({ runId: "a1", workflowSha: "wf", cwd: "/box/alpha", projectId: "proj-alpha" });
    store.enqueueRun({ runId: "a2", workflowSha: "wf", cwd: "/box2/alpha", projectId: "proj-alpha" });
    store.enqueueRun({ runId: "b1", workflowSha: "wf", cwd: "/box/beta", projectId: "proj-beta" });
    const res = await app.request("/runs?project_id=proj-alpha");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ runId: string; projectId?: string }>;
    expect(body.map((r) => r.runId).sort()).toEqual(["a1", "a2"]);
    expect(body.every((r) => r.projectId === "proj-alpha")).toBe(true);
  });
});
