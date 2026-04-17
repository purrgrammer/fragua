import { describe, expect, test } from "bun:test";
import { InMemorySink } from "../../src/events/sink.ts";
import { execute } from "../../src/executor/execute.ts";
import { QueueInterviewer } from "../../src/interviewer/index.ts";
import { parseDotSource } from "../../src/parser/parser.ts";

describe("wait.human handler — hexagon shape", () => {
  test("queued answer selects the matching labeled edge", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        gate [shape=hexagon, prompt="Approve the plan?"]
        proceed [shape=Msquare]
        abort [shape=Msquare]
        s -> gate
        gate -> proceed [label="[Y] Approve"]
        gate -> abort [label="[N] Abort"]
      }
    `);
    const iv = new QueueInterviewer([{ value: "Y", selected_option: { key: "Y", label: "Approve" } }]);
    const res = await execute({ graph, interviewer: iv });
    expect(res.completed_nodes).toContain("proceed");
    expect(res.completed_nodes).not.toContain("abort");
  });

  test("NO answer → fail outcome routes to abort branch", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        gate [shape=hexagon, prompt="Approve?"]
        proceed [shape=Msquare]
        abort [shape=Msquare]
        s -> gate
        gate -> proceed [condition="outcome=success"]
        gate -> abort [condition="outcome=fail"]
      }
    `);
    const iv = new QueueInterviewer([{ value: "NO" }]);
    const res = await execute({ graph, interviewer: iv });
    expect(res.completed_nodes).toContain("abort");
  });

  test("emits interview.started and interview.completed events", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        gate [shape=hexagon, prompt="OK?"]
        done [shape=Msquare]
        s -> gate
        gate -> done [label="Go"]
      }
    `);
    const sink = new InMemorySink();
    const iv = new QueueInterviewer([{ value: "Go", selected_option: { key: "1", label: "Go" } }]);
    await execute({ graph, interviewer: iv, sink });
    expect(sink.byType("interview.started").length).toBe(1);
    expect(sink.byType("interview.completed").length).toBe(1);
  });

  test("no options → CONFIRMATION question (just YES/NO)", async () => {
    const graph = parseDotSource(`
      digraph {
        s [shape=Mdiamond]
        gate [shape=hexagon, prompt="Continue?"]
        done [shape=Msquare]
        s -> gate -> done
      }
    `);
    const iv = new QueueInterviewer([{ value: "YES" }]);
    const res = await execute({ graph, interviewer: iv });
    expect(res.outcome.status).toBe("success");
  });
});
