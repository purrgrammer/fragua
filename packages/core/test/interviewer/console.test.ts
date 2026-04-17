import { describe, expect, test } from "bun:test";
import { ConsoleInterviewer } from "../../src/interviewer/console.ts";

function makeInterviewer(options: { input: string; timeoutMs?: number }) {
  const lines: string[] = [];
  const iv = new ConsoleInterviewer({
    writer: (s) => lines.push(s),
    reader: () =>
      options.timeoutMs !== undefined
        ? new Promise((r) => setTimeout(() => r(options.input), options.timeoutMs))
        : Promise.resolve(options.input),
  });
  return { iv, lines };
}

describe("ConsoleInterviewer", () => {
  test("YES_NO: 'y' → YES, anything else → NO", async () => {
    const { iv } = makeInterviewer({ input: "y\n" });
    expect((await iv.ask({ text: "Ok?", type: "YES_NO", stage: "t", metadata: {} })).value).toBe("YES");
    const { iv: iv2 } = makeInterviewer({ input: "nope\n" });
    expect((await iv2.ask({ text: "Ok?", type: "YES_NO", stage: "t", metadata: {} })).value).toBe("NO");
  });

  test("MULTIPLE_CHOICE: key match (case-insensitive) selects option", async () => {
    const { iv } = makeInterviewer({ input: "b\n" });
    const ans = await iv.ask({
      text: "Pick",
      type: "MULTIPLE_CHOICE",
      stage: "t",
      metadata: {},
      options: [
        { key: "A", label: "Alpha" },
        { key: "B", label: "Beta" },
      ],
    });
    expect(ans.value).toBe("B");
    expect(ans.selected_option?.label).toBe("Beta");
  });

  test("MULTIPLE_CHOICE: label match also works", async () => {
    const { iv } = makeInterviewer({ input: "Alpha\n" });
    const ans = await iv.ask({
      text: "Pick",
      type: "MULTIPLE_CHOICE",
      stage: "t",
      metadata: {},
      options: [
        { key: "A", label: "Alpha" },
        { key: "B", label: "Beta" },
      ],
    });
    expect(ans.selected_option?.key).toBe("A");
  });

  test("FREEFORM returns trimmed text", async () => {
    const { iv } = makeInterviewer({ input: "  some prose  \n" });
    const ans = await iv.ask({ text: "Thoughts?", type: "FREEFORM", stage: "t", metadata: {} });
    expect(ans.text).toBe("some prose");
  });

  test("timeout_seconds returns default when the reader stalls", async () => {
    const { iv } = makeInterviewer({ input: "y\n", timeoutMs: 200 });
    const ans = await iv.ask({
      text: "Ok?",
      type: "YES_NO",
      stage: "t",
      metadata: {},
      timeout_seconds: 0.05, // 50ms
      default: "YES",
    });
    expect(ans.value).toBe("YES");
  });

  test("timeout with no default → TIMEOUT sentinel", async () => {
    const { iv } = makeInterviewer({ input: "y\n", timeoutMs: 200 });
    const ans = await iv.ask({
      text: "Ok?",
      type: "YES_NO",
      stage: "t",
      metadata: {},
      timeout_seconds: 0.05,
    });
    expect(ans.value).toBe("TIMEOUT");
  });

  test("inform writes to the writer", () => {
    const { iv, lines } = makeInterviewer({ input: "" });
    iv.inform("hello", "stage-x");
    expect(lines.join("")).toContain("[stage-x] hello");
  });
});
