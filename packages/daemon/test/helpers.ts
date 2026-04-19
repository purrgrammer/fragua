import { handler } from "@swarm/core";
import { SqliteStore } from "@swarm/store";
import { Dispatcher } from "../src/dispatch.ts";

export interface TestRig {
  store: SqliteStore;
  dispatcher: Dispatcher;
  tools: handler.InMemoryToolRegistry;
  llmCall: handler.LlmCallFn;
  workflowSha: string;
}

export function rig(
  workflow: { sha?: string; name?: string; dot?: string } = {},
): TestRig {
  const store = new SqliteStore({ path: ":memory:" });
  const sha = workflow.sha ?? "wf";
  store.saveWorkflow(sha, workflow.name ?? "t", workflow.dot ?? "digraph{}");
  const dispatcher = new Dispatcher();
  const tools = new handler.InMemoryToolRegistry();
  const llmCall: handler.LlmCallFn = async () => ({
    content: "",
    tokens: 0,
    costUsd: 0,
    model: "stub",
  });
  return { store, dispatcher, tools, llmCall, workflowSha: sha };
}

export function registerTerminalEcho(
  dispatcher: Dispatcher,
  sha: string,
  nodeId: string,
): void {
  dispatcher.register(sha, nodeId, {
    kind: "echo",
    sideEffect: "none",
    maxMs: 1_000,
    handler: async () => ({
      kind: "transition",
      nextNode: "__end__",
      tokens: 0,
      costUsd: 0,
    }),
  });
}

export function enqueue(
  rig: TestRig,
  runId: string,
  startNode: string,
  priority = 0,
): void {
  rig.store.enqueueRun({
    runId,
    workflowSha: rig.workflowSha,
    priority,
    initialRouting: { start_node: startNode },
  });
}
