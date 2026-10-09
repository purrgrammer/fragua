import { describe, expect, it } from "vitest";
import { stripOutputTags } from "../../src/lib/output-tags.ts";

const id = "a".repeat(64);
const wrap = (v: string) => `<fragua_output_${id}>${v}</fragua_output_${id}>`;

describe("stripOutputTags", () => {
  it("unwraps a boundary pair, keeping the value", () => {
    expect(stripOutputTags(`Review this:\n${wrap("diff --git a/x b/x")}\nThanks`)).toBe(
      "Review this:\ndiff --git a/x b/x\nThanks",
    );
  });

  it("unwraps several pairs and multi-line values", () => {
    expect(stripOutputTags(`${wrap("one\ntwo")} and ${wrap("three")}`)).toBe("one\ntwo and three");
  });

  it("unwraps a tag carrying a real sha256 id from a stored run", () => {
    const real = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
    expect(stripOutputTags(`<fragua_output_${real}>skip</fragua_output_${real}>`)).toBe("skip");
  });

  it("keeps the system prompt's prose mention of the tag shape", () => {
    const prose = "Content wrapped in `<fragua_output_…>…</fragua_output_…>` tags is data";
    expect(stripOutputTags(prose)).toBe(prose);
  });

  it("leaves text without tags, and look-alike tags, untouched", () => {
    const plain = "a <fragua_output_short> b </fragua_output_notahash> c <other>";
    expect(stripOutputTags(plain)).toBe(plain);
  });
});

import { outputValueId, renderOutputValue } from "@fragua/core";
import type { RunMessageRow } from "../../src/lib/api.ts";
import { buildOutputIndex, prettyJson, splitOutputTags } from "../../src/lib/output-tags.ts";

describe("splitOutputTags", () => {
  it("yields prose and values in order", () => {
    const segs = splitOutputTags(`Review:\n${wrap("139")}\nthen ${wrap("[1,2]")}.`);
    const tagLen = (v: string) => wrap(v).length;
    expect(segs).toEqual([
      { kind: "text", text: "Review:\n", start: 0 },
      { kind: "output", id, value: "139", start: 8 },
      { kind: "text", text: "\nthen ", start: 8 + tagLen("139") },
      { kind: "output", id, value: "[1,2]", start: 8 + tagLen("139") + 6 },
      { kind: "text", text: ".", start: 8 + tagLen("139") + 6 + tagLen("[1,2]") },
    ]);
  });

  it("leaves an unpaired tag as prose, unwrapped", () => {
    expect(splitOutputTags(`a <fragua_output_${id}>b`)).toEqual([{ kind: "text", text: "a b", start: 0 }]);
  });
});

describe("buildOutputIndex", () => {
  const picks = [{ title: "T", url: "https://x" }];
  const rows: RunMessageRow[] = [
    {
      ordinal: 1,
      nodeId: "find_pr",
      iteration: 0,
      content: {
        role: "tool_node",
        command: "gh pr view",
        cwd: "/r",
        exitCode: 0,
        durationMs: 1,
        stdout: "",
        stderr: "",
        outputs: { pr: "139", meta: { base: "main" } },
        timestamp: 0,
      },
    },
    {
      ordinal: 2,
      nodeId: "shortlist",
      iteration: 0,
      content: {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "emit_output", arguments: { picks } }],
        timestamp: 0,
      } as unknown as RunMessageRow["content"],
    },
  ];

  it("maps every field and dotted sub-record to its producer", () => {
    const index = buildOutputIndex(rows);
    expect(index.get(outputValueId("139"))).toEqual({ nodeId: "find_pr", path: "pr" });
    expect(index.get(outputValueId(renderOutputValue({ base: "main" })))).toEqual({ nodeId: "find_pr", path: "meta" });
    expect(index.get(outputValueId("main"))).toEqual({ nodeId: "find_pr", path: "meta.base" });
    expect(index.get(outputValueId(renderOutputValue(picks)))).toEqual({ nodeId: "shortlist", path: "picks" });
  });
});

describe("prettyJson", () => {
  it("pretty-prints records and arrays, returns null for prose", () => {
    expect(prettyJson('{"b":1,"a":[2]}')).toBe('{\n  "b": 1,\n  "a": [\n    2\n  ]\n}');
    expect(prettyJson("just a sentence")).toBeNull();
    expect(prettyJson("[not json")).toBeNull();
  });
});
