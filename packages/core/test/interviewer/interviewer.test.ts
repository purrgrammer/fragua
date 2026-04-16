import { describe, expect, test } from "bun:test";
import { AutoApproveInterviewer, QueueInterviewer, RecordingInterviewer } from "../../src/interviewer/index.ts";
import type { Question } from "../../src/types/interviewer.ts";

function yesNo(text = "Continue?"): Question {
  return { text, type: "YES_NO", stage: "t", metadata: {} };
}

function mcq(): Question {
  return {
    text: "Pick one",
    type: "MULTIPLE_CHOICE",
    stage: "t",
    metadata: {},
    options: [
      { key: "A", label: "Alpha" },
      { key: "B", label: "Beta" },
    ],
  };
}

function freeform(): Question {
  return { text: "Say something", type: "FREEFORM", stage: "t", metadata: {} };
}

describe("AutoApproveInterviewer", () => {
  test("YES_NO → YES", async () => {
    const iv = new AutoApproveInterviewer();
    expect((await iv.ask(yesNo())).value).toBe("YES");
  });

  test("CONFIRMATION → YES", async () => {
    const iv = new AutoApproveInterviewer();
    expect((await iv.ask({ text: "?", type: "CONFIRMATION", stage: "t", metadata: {} })).value).toBe("YES");
  });

  test("MULTIPLE_CHOICE → first option", async () => {
    const iv = new AutoApproveInterviewer();
    const ans = await iv.ask(mcq());
    expect(ans.value).toBe("A");
    expect(ans.selected_option?.label).toBe("Alpha");
  });

  test("FREEFORM → empty", async () => {
    const iv = new AutoApproveInterviewer();
    expect((await iv.ask(freeform())).text).toBe("");
  });

  test("ask_multiple batches", async () => {
    const iv = new AutoApproveInterviewer();
    const out = await iv.ask_multiple([yesNo(), mcq()]);
    expect(out).toHaveLength(2);
  });
});

describe("QueueInterviewer", () => {
  test("drains FIFO", async () => {
    const iv = new QueueInterviewer([{ value: "NO" }, { value: "YES" }]);
    expect((await iv.ask(yesNo())).value).toBe("NO");
    expect((await iv.ask(yesNo())).value).toBe("YES");
  });

  test("throws when empty", async () => {
    const iv = new QueueInterviewer();
    await expect(iv.ask(yesNo())).rejects.toThrow("no more answers queued");
  });

  test("enqueue adds more", async () => {
    const iv = new QueueInterviewer();
    iv.enqueue({ value: "YES" });
    expect((await iv.ask(yesNo())).value).toBe("YES");
  });

  test("captures inform calls", () => {
    const iv = new QueueInterviewer();
    iv.inform("hi", "stage-a");
    expect(iv.informed).toEqual([{ message: "hi", stage: "stage-a" }]);
  });

  test("ask_multiple consumes multiple", async () => {
    const iv = new QueueInterviewer([{ value: "A" }, { value: "B" }]);
    const out = await iv.ask_multiple([mcq(), mcq()]);
    expect(out.map((o) => o.value)).toEqual(["A", "B"]);
    expect(iv.remaining).toBe(0);
  });
});

describe("RecordingInterviewer", () => {
  test("records every Q/A pair", async () => {
    const inner = new QueueInterviewer([{ value: "YES" }, { value: "NO" }]);
    const now = (() => {
      let i = 0;
      return () => `2026-01-01T00:00:0${i++}Z`;
    })();
    const rec = new RecordingInterviewer(inner, now);
    const q1 = yesNo("one");
    const q2 = yesNo("two");
    await rec.ask(q1);
    await rec.ask(q2);
    expect(rec.records).toHaveLength(2);
    expect(rec.records[0]!.question.text).toBe("one");
    expect(rec.records[0]!.timestamp).toBe("2026-01-01T00:00:00Z");
    expect(rec.records[1]!.timestamp).toBe("2026-01-01T00:00:01Z");
  });

  test("records ask_multiple as individual entries", async () => {
    const inner = new QueueInterviewer([{ value: "A" }, { value: "B" }]);
    const rec = new RecordingInterviewer(inner);
    await rec.ask_multiple([mcq(), mcq()]);
    expect(rec.records).toHaveLength(2);
  });

  test("inform passes through and is recorded", () => {
    const inner = new QueueInterviewer();
    const rec = new RecordingInterviewer(inner);
    rec.inform("x", "stage");
    expect(rec.informed).toHaveLength(1);
    expect(inner.informed).toEqual([{ message: "x", stage: "stage" }]);
  });
});
