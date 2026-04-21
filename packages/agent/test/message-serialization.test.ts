// Serialization of pi-agent-core AgentMessages into the swarm messages
// table `content` column. The messages table is the primary transcript
// surface (§I9) — it feeds both the web UI and the resume seed. It must
// preserve:
//
//   1. tool_use blocks on assistant messages (name + arguments + id +
//      optional thoughtSignature for Gemini multi-turn continuity)
//   2. tool_result pairing by tool_use_id + error flag + tool name
//   3. thinking blocks — first-class in pi-mono's web-ui; swarm
//      matches that treatment. Preserves thinkingSignature (Anthropic
//      Extended Thinking) and redacted flag (opaque safety-filtered
//      payload) so multi-turn continuation works if a future fidelity
//      mode ever pipes the transcript back to the provider.
//   4. the original block order (text + thinking + toolCall)
//   5. plain-text messages unchanged (regression guard)
//
// Run 01kpphw9wbe27khyse was the repro: tool_use blocks were silently
// dropped on the way in, so `role='assistant'` rows showed only
// narration and `role='tool'` rows had no pointer back to the call that
// produced them. The fix is a structured string format using
// `<tool_use>` / `<tool_result>` / `<thinking>` tags
// with a `tool_use_id` pairing key; tests below pin the contract.
//
// Invariants guarded:
//   - plain-text messages serialize to identical plain text
//   - image blocks stay dropped (not a transcript concern yet)
//   - textSignature on text blocks stays dropped (summary:high resume
//     degrade means raw-replay fidelity isn't needed today)
//   - custom / UI-only roles stay filtered out at persist time

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { persistAgentMessage, serializeAgentMessage } from "../src/backend.ts";

type Captured = { role: string; content: string };

function capture(): {
  persist: (role: "assistant" | "tool" | "user" | "system", content: string) => void;
  rows: Captured[];
} {
  const rows: Captured[] = [];
  return {
    persist: (role, content) => {
      rows.push({ role, content });
    },
    rows,
  };
}

describe("serializeAgentMessage — assistant", () => {
  test("plain text only → identical plain text (regression)", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "Just a thought." }],
    });
    expect(out).toBe("Just a thought.");
  });

  test("string content (non-array) → identical plain text", () => {
    const out = serializeAgentMessage({
      role: "user",
      content: "raw user prompt",
    });
    expect(out).toBe("raw user prompt");
  });

  test("text + toolCall → both preserved, pairing id extractable", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Let me read the file first." },
        {
          type: "toolCall",
          id: "toolu_01xxx",
          name: "read",
          arguments: { path: "/tmp/foo" },
        },
      ],
    });
    expect(out).toContain("Let me read the file first.");
    expect(out).toMatch(/<tool_use\b/);
    expect(out).toContain('id="toolu_01xxx"');
    expect(out).toContain('name="read"');
    expect(out).toContain('"path":"/tmp/foo"');
    // Parseable: regex recovers the tool_use_id
    const m = out.match(/<tool_use[^>]*\bid="([^"]+)"/);
    expect(m?.[1]).toBe("toolu_01xxx");
  });

  test("block order preserved under interleaved text + toolCalls", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        { type: "text", text: "First thought." },
        { type: "toolCall", id: "a", name: "read", arguments: {} },
        { type: "text", text: "Second thought." },
        { type: "toolCall", id: "b", name: "bash", arguments: { command: "ls" } },
      ],
    });
    const iFirst = out.indexOf("First thought.");
    const iA = out.indexOf('id="a"');
    const iSecond = out.indexOf("Second thought.");
    const iB = out.indexOf('id="b"');
    expect(iFirst).toBeGreaterThanOrEqual(0);
    expect(iA).toBeGreaterThan(iFirst);
    expect(iSecond).toBeGreaterThan(iA);
    expect(iB).toBeGreaterThan(iSecond);
  });

  test("toolCall arguments JSON-encoded with stable shape for nested objects", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "c",
          name: "edit",
          arguments: {
            path: "/a/b.ts",
            old_string: "foo",
            new_string: "bar",
            nested: { k: [1, 2, 3] },
          },
        },
      ],
    });
    // Arguments block is a valid JSON object we can round-trip
    const body = out.match(/<tool_use[^>]*>([\s\S]*?)<\/tool_use>/)?.[1];
    expect(body).toBeDefined();
    const parsed = JSON.parse(body ?? "{}");
    expect(parsed).toEqual({
      path: "/a/b.ts",
      old_string: "foo",
      new_string: "bar",
      nested: { k: [1, 2, 3] },
    });
  });

  test("toolCall with empty arguments serializes `{}`", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "e", name: "ping", arguments: {} }],
    });
    const body = out.match(/<tool_use[^>]*>([\s\S]*?)<\/tool_use>/)?.[1]?.trim();
    expect(body).toBe("{}");
  });

  test("thinking blocks are preserved as <thinking> wrappers", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning step one" },
        { type: "text", text: "visible output" },
      ],
    });
    expect(out).toContain("reasoning step one");
    expect(out).toMatch(/<thinking>/);
    expect(out).toContain("</thinking>");
    expect(out).toContain("visible output");
    // Order: thinking before text
    expect(out.indexOf("reasoning step one")).toBeLessThan(out.indexOf("visible output"));
  });

  test("empty thinking content is dropped (nothing meaningful to store)", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "only this" },
      ],
    });
    expect(out).toBe("only this");
  });

  test("thinking with thinkingSignature survives as signature attribute", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "reasoning",
          thinkingSignature: "sig_abc123",
        },
      ],
    });
    expect(out).toContain('signature="sig_abc123"');
    expect(out).toContain("reasoning");
  });

  test("thinking with redacted=true surfaces the flag", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "[redacted payload]",
          thinkingSignature: "opaque",
          redacted: true,
        },
      ],
    });
    expect(out).toContain('redacted="true"');
    expect(out).toContain('signature="opaque"');
  });

  test("toolCall thoughtSignature (Gemini) round-trips as thought_signature attribute", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "c1",
          name: "read",
          arguments: { path: "/a" },
          thoughtSignature: "gemini_sig_xyz",
        },
      ],
    });
    expect(out).toContain('thought_signature="gemini_sig_xyz"');
    expect(out).toContain('id="c1"');
  });

  test("toolCall without thoughtSignature omits the attribute", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
    });
    expect(out).not.toContain("thought_signature");
  });

  test("text + thinking + toolCall order is preserved", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [
        { type: "text", text: "before thinking" },
        { type: "thinking", thinking: "middle reasoning" },
        { type: "toolCall", id: "t1", name: "read", arguments: {} },
        { type: "text", text: "after tool" },
      ],
    });
    const iBefore = out.indexOf("before thinking");
    const iThink = out.indexOf("middle reasoning");
    const iTool = out.indexOf('id="t1"');
    const iAfter = out.indexOf("after tool");
    expect(iBefore).toBeGreaterThanOrEqual(0);
    expect(iThink).toBeGreaterThan(iBefore);
    expect(iTool).toBeGreaterThan(iThink);
    expect(iAfter).toBeGreaterThan(iTool);
  });

  test("toolCall-only assistant (no text blocks) → content still non-empty", () => {
    const out = serializeAgentMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "only", name: "bash", arguments: { command: "pwd" } }],
    });
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('id="only"');
    expect(out).toContain('name="bash"');
  });
});

describe("serializeAgentMessage — toolResult", () => {
  test("body + tool_use_id + tool_name + is_error preserved", () => {
    const out = serializeAgentMessage({
      role: "toolResult",
      toolCallId: "toolu_01xxx",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "// file contents\nhello" }],
    });
    expect(out).toMatch(/<tool_result\b/);
    expect(out).toContain('tool_use_id="toolu_01xxx"');
    expect(out).toContain('tool_name="read"');
    expect(out).toContain('is_error="false"');
    expect(out).toContain("// file contents\nhello");
  });

  test("is_error=true surfaces the error flag", () => {
    const out = serializeAgentMessage({
      role: "toolResult",
      toolCallId: "err1",
      toolName: "bash",
      isError: true,
      content: [{ type: "text", text: "ENOENT" }],
    });
    expect(out).toContain('is_error="true"');
    expect(out).toContain("ENOENT");
  });

  test("multi-block text content joined on newlines inside the wrapper", () => {
    const out = serializeAgentMessage({
      role: "toolResult",
      toolCallId: "m",
      toolName: "bash",
      isError: false,
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });
    expect(out).toContain("line one");
    expect(out).toContain("line two");
    // Body is parseable with a tolerant regex
    const body = out.match(/<tool_result[^>]*>([\s\S]*?)<\/tool_result>/)?.[1];
    expect(body).toBeDefined();
    expect(body ?? "").toContain("line one");
    expect(body ?? "").toContain("line two");
  });

  test("image blocks dropped (not a transcript concern)", () => {
    const out = serializeAgentMessage({
      role: "toolResult",
      toolCallId: "i",
      toolName: "read",
      isError: false,
      content: [
        { type: "text", text: "visible" },
        { type: "image", data: "<binary>", mimeType: "image/png" },
      ],
    });
    expect(out).toContain("visible");
    expect(out).not.toContain("<binary>");
  });

  test("empty content still produces a well-formed empty wrapper", () => {
    const out = serializeAgentMessage({
      role: "toolResult",
      toolCallId: "empty",
      toolName: "bash",
      isError: false,
      content: [],
    });
    expect(out).toContain('tool_use_id="empty"');
    expect(out).toMatch(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/);
  });
});

describe("persistAgentMessage — full round-trip", () => {
  test("assistant + toolResult pair can be rejoined on tool_use_id (run 01kpphw9wbe27khyse regression)", () => {
    const { persist, rows } = capture();

    persistAgentMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me look at the file first to understand the current structure." },
          {
            type: "toolCall",
            id: "toolu_bdrk_01Uffuqgi8dTYkauVwaWxkjq",
            name: "read",
            arguments: {
              path: "/Users/bandarra/swarm/.swarm/worktrees/01kpphw9wbe27khyse/packages/web/src/components/RunConversation.tsx",
            },
          },
        ],
      },
      persist,
    );

    persistAgentMessage(
      {
        role: "toolResult",
        toolCallId: "toolu_bdrk_01Uffuqgi8dTYkauVwaWxkjq",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "// RunConversation — …\nexport function …" }],
      },
      persist,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.role).toBe("assistant");
    expect(rows[1]?.role).toBe("tool");

    const callId = rows[0]?.content.match(/<tool_use[^>]*\bid="([^"]+)"/)?.[1];
    const resultId = rows[1]?.content.match(/<tool_result[^>]*\btool_use_id="([^"]+)"/)?.[1];
    expect(callId).toBeDefined();
    expect(resultId).toBeDefined();
    expect(callId ?? "").toBe(resultId ?? "");
  });

  test("maps pi-agent-core roles to swarm MessageRole (toolResult → tool)", () => {
    const { persist, rows } = capture();
    persistAgentMessage(
      {
        role: "toolResult",
        toolCallId: "x",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "hi" }],
      },
      persist,
    );
    expect(rows[0]?.role).toBe("tool");
  });

  test("custom / UI-only roles are filtered out (no row written)", () => {
    const { persist, rows } = capture();
    persistAgentMessage({ role: "custom-ui", content: [{ type: "text", text: "ignore me" }] }, persist);
    expect(rows).toHaveLength(0);
  });

  test("empty content → no row written (don't pollute the transcript)", () => {
    const { persist, rows } = capture();
    persistAgentMessage({ role: "assistant", content: [] }, persist);
    persistAgentMessage({ role: "assistant", content: [{ type: "thinking", thinking: "" }] }, persist);
    expect(rows).toHaveLength(0);
  });

  test("thinking-only assistant produces a row (pi-mono parity)", () => {
    const { persist, rows } = capture();
    persistAgentMessage({ role: "assistant", content: [{ type: "thinking", thinking: "just reasoning" }] }, persist);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("assistant");
    expect(rows[0]?.content).toContain("just reasoning");
  });

  test("plain-text assistant still lands as bare text (regression)", () => {
    const { persist, rows } = capture();
    persistAgentMessage({ role: "assistant", content: [{ type: "text", text: "plain reply" }] }, persist);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("plain reply");
  });
});

// ─── property tests ──────────────────────────────────────────────
//
// Bound the fuzz space tightly: arbitrary strings in `text` make
// position-matching assertions brittle because one block's text can be
// a substring of another block's wrapper (e.g. text="id=\"foo\"" inside
// a tool_use's args). The arbitraries below constrain text to
// non-angle-bracket ASCII so "is this substring present" and "is the
// order preserved" have unambiguous meaning — without sacrificing the
// goal of the property (structural invariants under arbitrary shape).

// Non-empty ASCII text bounded to (a) exclude tag-grammar characters
// (`<>&"`) that would clash with our wrappers and (b) forbid any
// leading/trailing whitespace — the serializer joins blocks with
// `\n\n` and `.trim()`s the outer concat, which would confound
// substring-based assertions on blocks whose text ends in a space.
// First and last char must be alphanumeric; middle chars may include
// a limited printable ASCII set.
const safeTextArb = fc.stringMatching(/^[A-Za-z0-9]([A-Za-z0-9 _.:=!?()\-]{0,38}[A-Za-z0-9])?$/);

const toolIdArb = fc.stringMatching(/^[a-zA-Z0-9_]{3,24}$/);
const toolNameArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);

const jsonScalarArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
);
// Shallow record of JSON-safe values — deep enough to exercise
// JSON.stringify, shallow enough to keep tests fast + deterministic.
const toolArgsArb = fc.dictionary(fc.stringMatching(/^[a-z_][a-z0-9_]{0,8}$/), jsonScalarArb, { maxKeys: 5 });

const textBlockArb = fc.record({ type: fc.constant("text"), text: safeTextArb });
const toolCallBlockArb = fc.record({
  type: fc.constant("toolCall"),
  id: toolIdArb,
  name: toolNameArb,
  arguments: toolArgsArb,
});
const assistantBlockArb = fc.oneof(textBlockArb, toolCallBlockArb);

describe("property: serializeAgentMessage", () => {
  test("toolCall id is recoverable by regex", () => {
    fc.assert(
      fc.property(toolCallBlockArb, (call) => {
        const out = serializeAgentMessage({ role: "assistant", content: [call] });
        const m = out.match(/<tool_use[^>]*\bid="([^"]+)"/);
        return m?.[1] === call.id;
      }),
    );
  });

  test("toolCall name is recoverable by regex", () => {
    fc.assert(
      fc.property(toolCallBlockArb, (call) => {
        const out = serializeAgentMessage({ role: "assistant", content: [call] });
        const m = out.match(/<tool_use[^>]*\bname="([^"]+)"/);
        return m?.[1] === call.name;
      }),
    );
  });

  test("toolCall arguments round-trip through JSON parse", () => {
    fc.assert(
      fc.property(toolCallBlockArb, (call) => {
        const out = serializeAgentMessage({ role: "assistant", content: [call] });
        const body = out.match(/<tool_use[^>]*>([\s\S]*?)<\/tool_use>/)?.[1];
        if (body == null) return false;
        const parsed = JSON.parse(body);
        return JSON.stringify(parsed) === JSON.stringify(call.arguments);
      }),
    );
  });

  test("block order is preserved through serialization", () => {
    fc.assert(
      fc.property(fc.array(assistantBlockArb, { minLength: 1, maxLength: 6 }), (blocks) => {
        const out = serializeAgentMessage({ role: "assistant", content: blocks });
        let cursor = 0;
        for (const b of blocks) {
          const needle = "text" in b ? b.text : `id="${b.id}"`;
          const idx = out.indexOf(needle, cursor);
          if (idx < 0) return false;
          cursor = idx + needle.length;
        }
        return true;
      }),
    );
  });

  test("toolResult pair shares the same id as its originating toolCall", () => {
    fc.assert(
      fc.property(toolCallBlockArb, safeTextArb, (call, body) => {
        const asst = serializeAgentMessage({ role: "assistant", content: [call] });
        const tool = serializeAgentMessage({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          content: [{ type: "text", text: body }],
        });
        const callId = asst.match(/<tool_use[^>]*\bid="([^"]+)"/)?.[1];
        const resultId = tool.match(/<tool_result[^>]*\btool_use_id="([^"]+)"/)?.[1];
        return callId !== undefined && callId === resultId;
      }),
    );
  });

  test("toolResult body is preserved verbatim inside the wrapper", () => {
    fc.assert(
      fc.property(toolIdArb, toolNameArb, safeTextArb, fc.boolean(), (id, name, text, isError) => {
        const out = serializeAgentMessage({
          role: "toolResult",
          toolCallId: id,
          toolName: name,
          isError,
          content: [{ type: "text", text }],
        });
        const body = out.match(/<tool_result[^>]*>([\s\S]*?)<\/tool_result>/)?.[1]?.trim();
        return body === text && out.includes(`is_error="${isError}"`);
      }),
    );
  });

  test("thinking text round-trips verbatim inside <thinking>", () => {
    // Use disjoint alphabets so substring-extraction is unambiguous:
    // thinking uses uppercase, visible uses lowercase.
    const thinkTextArb = fc.stringMatching(/^[A-Z]{3,20}$/);
    const visibleTextArb = fc.stringMatching(/^[a-z]{3,20}$/);
    const thinkArb = fc.record({ type: fc.constant("thinking"), thinking: thinkTextArb });
    fc.assert(
      fc.property(thinkArb, visibleTextArb, (think, visible) => {
        const out = serializeAgentMessage({
          role: "assistant",
          content: [think, { type: "text", text: visible }],
        });
        const m = out.match(/<thinking[^>]*>([\s\S]*?)<\/thinking>/);
        return m?.[1]?.trim() === think.thinking && out.includes(visible);
      }),
    );
  });

  test("thoughtSignature on toolCall round-trips through attribute", () => {
    const sigArb = fc.stringMatching(/^[A-Za-z0-9+/=_\-]{4,40}$/);
    fc.assert(
      fc.property(toolCallBlockArb, sigArb, (call, sig) => {
        const out = serializeAgentMessage({
          role: "assistant",
          content: [{ ...call, thoughtSignature: sig }],
        });
        const m = out.match(/<tool_use[^>]*\bthought_signature="([^"]+)"/);
        return m?.[1] === sig;
      }),
    );
  });

  test("thinkingSignature on thinking block round-trips through attribute", () => {
    const sigArb = fc.stringMatching(/^[A-Za-z0-9+/=_\-]{4,40}$/);
    const thinkTextArb = fc.stringMatching(/^[A-Z][A-Za-z0-9 ]{3,20}[A-Za-z0-9]$/);
    fc.assert(
      fc.property(thinkTextArb, sigArb, fc.boolean(), (thinking, sig, redacted) => {
        const out = serializeAgentMessage({
          role: "assistant",
          content: [{ type: "thinking", thinking, thinkingSignature: sig, redacted }],
        });
        const sigMatch = out.match(/<thinking[^>]*\bsignature="([^"]+)"/);
        if (sigMatch?.[1] !== sig) return false;
        const redactedPresent = /<thinking[^>]*\bredacted="true"/.test(out);
        return redactedPresent === redacted;
      }),
    );
  });

  test("image blocks in toolResult never leak into serialized body", () => {
    const imageArb = fc.record({
      type: fc.constant("image"),
      data: fc.stringMatching(/^[A-Za-z0-9+/]{12,40}={0,2}$/),
      mimeType: fc.constant("image/png"),
    });
    fc.assert(
      fc.property(fc.array(imageArb, { minLength: 1, maxLength: 4 }), safeTextArb, (imgs, visible) => {
        const content = [...imgs, { type: "text", text: visible }];
        const out = serializeAgentMessage({
          role: "toolResult",
          toolCallId: "x",
          toolName: "y",
          isError: false,
          content,
        });
        return imgs.every((i) => !out.includes(i.data)) && out.includes(visible);
      }),
    );
  });

  test('escapeAttr: output never contains unescaped `"` inside attribute slots', () => {
    // Attribute values come only from toolCallId / toolName / tool-use id+name.
    // Even if the source contains a `"` (pathological but possible), the
    // generated `id="..."` / `name="..."` slots must close exactly once.
    const hostileStrArb = fc.string({ minLength: 1, maxLength: 20 });
    fc.assert(
      fc.property(hostileStrArb, hostileStrArb, (id, name) => {
        const out = serializeAgentMessage({
          role: "toolResult",
          toolCallId: id,
          toolName: name,
          isError: false,
          content: [{ type: "text", text: "body" }],
        });
        // There's exactly one opening tag; the three attribute slots must
        // each close cleanly. Extract and verify.
        const m = out.match(/^<tool_result tool_use_id="([^"]*)" tool_name="([^"]*)" is_error="(true|false)">/);
        return m !== null;
      }),
    );
  });

  test("serializing assistant then toolResult is independent — no shared mutable state", () => {
    fc.assert(
      fc.property(toolCallBlockArb, (call) => {
        const a1 = serializeAgentMessage({ role: "assistant", content: [call] });
        const a2 = serializeAgentMessage({ role: "assistant", content: [call] });
        const t1 = serializeAgentMessage({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          content: [{ type: "text", text: "r" }],
        });
        const t2 = serializeAgentMessage({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          isError: false,
          content: [{ type: "text", text: "r" }],
        });
        return a1 === a2 && t1 === t2;
      }),
    );
  });
});

describe("property: persistAgentMessage", () => {
  test("well-formed message with content produces exactly one row", () => {
    fc.assert(
      fc.property(fc.array(assistantBlockArb, { minLength: 1, maxLength: 4 }), (blocks) => {
        const rows: { role: string; content: string }[] = [];
        persistAgentMessage({ role: "assistant", content: blocks }, (role, content) => rows.push({ role, content }));
        // 1 row iff at least one block produced non-empty output.
        const hasNonEmpty = blocks.some((b) => b.type === "text" || b.type === "toolCall");
        return rows.length === (hasNonEmpty ? 1 : 0);
      }),
    );
  });

  test("unknown roles never produce a row", () => {
    const knownRoles = new Set(["assistant", "user", "system", "tool", "toolResult"]);
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !knownRoles.has(s)),
        safeTextArb,
        (role, text) => {
          const rows: unknown[] = [];
          persistAgentMessage({ role, content: [{ type: "text", text }] }, () => rows.push(1));
          return rows.length === 0;
        },
      ),
    );
  });
});
