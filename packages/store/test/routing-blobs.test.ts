import { describe, expect, test } from "bun:test";
import {
  BLOB_REF_SENTINEL,
  collectRoutingBlobShas,
  isBlobRef,
  makeBlobRef,
  materializeRouting,
  PER_VALUE_SPILL_BYTES,
  ROUTING_SPILL_MARGIN_BYTES,
  spillRoutingInputs,
} from "../src/routing-blobs.ts";

const VALID_SHA = "a".repeat(64);
const enc = new TextEncoder();

describe("isBlobRef", () => {
  test("accepts a well-formed ref", () => {
    expect(isBlobRef({ [BLOB_REF_SENTINEL]: VALID_SHA, bytes: 10 })).toBe(true);
  });

  test("rejects short sha", () => {
    expect(isBlobRef({ [BLOB_REF_SENTINEL]: "short", bytes: 1 })).toBe(false);
  });

  test("rejects non-hex sha", () => {
    expect(isBlobRef({ [BLOB_REF_SENTINEL]: "z".repeat(64), bytes: 1 })).toBe(false);
  });

  test("rejects numeric sentinel", () => {
    expect(isBlobRef({ [BLOB_REF_SENTINEL]: 1, bytes: 1 })).toBe(false);
  });

  test("rejects missing bytes field", () => {
    expect(isBlobRef({ [BLOB_REF_SENTINEL]: VALID_SHA })).toBe(false);
  });

  test("rejects non-integer bytes", () => {
    expect(isBlobRef({ [BLOB_REF_SENTINEL]: VALID_SHA, bytes: 1.5 })).toBe(false);
  });

  test("rejects negative bytes", () => {
    expect(isBlobRef({ [BLOB_REF_SENTINEL]: VALID_SHA, bytes: -1 })).toBe(false);
  });

  test("rejects empty object", () => {
    expect(isBlobRef({})).toBe(false);
  });

  test("rejects null", () => {
    expect(isBlobRef(null)).toBe(false);
  });

  test("rejects string", () => {
    expect(isBlobRef("string")).toBe(false);
  });

  test("rejects array", () => {
    expect(isBlobRef([])).toBe(false);
  });
});

describe("makeBlobRef", () => {
  test("produces a valid ref", () => {
    const ref = makeBlobRef(VALID_SHA, 42);
    expect(isBlobRef(ref)).toBe(true);
    expect(ref[BLOB_REF_SENTINEL]).toBe(VALID_SHA);
    expect(ref.bytes).toBe(42);
  });
});

describe("spillRoutingInputs — small routing (no spill)", () => {
  test("(e) small routing.inputs left untouched — no blob, no ref", () => {
    const blobs: Array<{ sha: string; bytes: Uint8Array }> = [];
    const routing = { inputs: { x: "hi", y: "there" } };
    const result = spillRoutingInputs(routing, (sha, b) => blobs.push({ sha, bytes: b }));
    expect(result.spilled).toHaveLength(0);
    expect(blobs).toHaveLength(0);
    expect(result.routing).toBe(routing); // same ref — no clone when nothing spilled
    expect((result.routing["inputs"] as Record<string, unknown>)["x"]).toBe("hi");
  });

  test("routing without inputs key is returned as-is", () => {
    const routing = { priority: 1, start_node: "start" };
    const result = spillRoutingInputs(routing, () => {
      throw new Error("should not be called");
    });
    expect(result.spilled).toHaveLength(0);
    expect(result.routing).toBe(routing);
  });

  test("routing with non-object inputs is returned as-is", () => {
    const routing = { inputs: "not-an-object" } as unknown as Record<string, unknown>;
    const result = spillRoutingInputs(routing, () => {
      throw new Error("should not be called");
    });
    expect(result.spilled).toHaveLength(0);
    expect(result.routing).toBe(routing);
  });
});

describe("spillRoutingInputs — per-value threshold", () => {
  test("a single value over PER_VALUE_SPILL_BYTES is spilled even when total is under margin", () => {
    const bigVal = "x".repeat(PER_VALUE_SPILL_BYTES + 1);
    const routing = { inputs: { task: bigVal } };
    const blobs: Array<{ sha: string; bytes: Uint8Array }> = [];
    const result = spillRoutingInputs(routing, (sha, b) => blobs.push({ sha, bytes: b }));

    expect(result.spilled).toHaveLength(1);
    expect(blobs).toHaveLength(1);
    const inputs = result.routing["inputs"] as Record<string, unknown>;
    expect(isBlobRef(inputs["task"])).toBe(true);
    const ref = inputs["task"] as ReturnType<typeof makeBlobRef>;
    expect(ref.bytes).toBe(enc.encode(bigVal).length);
    // The blob bytes decode to the original value
    expect(new TextDecoder().decode(blobs[0]!.bytes)).toBe(bigVal);
  });
});

describe("spillRoutingInputs — margin-driven spill", () => {
  test("spills largest values first until routing is under the margin", () => {
    // Build inputs where total routing exceeds the margin but no single value
    // exceeds PER_VALUE_SPILL_BYTES; we make them all just under the per-value
    // threshold, but pile enough to exceed the margin.
    const smallish = "x".repeat(PER_VALUE_SPILL_BYTES - 1);
    const inputs: Record<string, string> = {};
    // 4 keys of ~1023 bytes each → total inputs JSON ~4*1023 > 3072
    inputs["a"] = `a${smallish.slice(1)}`; // 1023 bytes
    inputs["b"] = `b${smallish.slice(1)}`; // 1023 bytes
    inputs["c"] = `c${smallish.slice(1)}`; // 1023 bytes
    inputs["d"] = `d${smallish.slice(1)}`; // 1023 bytes

    const routing = { inputs };
    const blobs: string[] = [];
    const result = spillRoutingInputs(routing, (sha) => blobs.push(sha));

    // Routing should now be under the margin
    expect(JSON.stringify(result.routing).length).toBeLessThan(ROUTING_SPILL_MARGIN_BYTES);
    // Some values must have been spilled
    expect(result.spilled.length).toBeGreaterThan(0);
  });

  test("(regression) many small MULTIBYTE inputs spill — the margin is UTF-8 BYTES, not UTF-16 length", () => {
    // Each value is 341 code points of a 3-byte char = 341 UTF-16 units / 1023
    // bytes. None individually exceeds PER_VALUE_SPILL_BYTES, and their summed
    // UTF-16 length stays under ROUTING_SPILL_MARGIN_BYTES — so a length-based
    // margin (the old bug) would never fire, they would all land inline, and the
    // ~8 KiB byte payload would bust the 4 KiB genesis cap with a raw
    // PayloadTooLargeError. The byte-honest margin must spill them instead.
    const inputs: Record<string, string> = {};
    for (let i = 0; i < 8; i++) inputs[`k${i}`] = "一".repeat(341);
    const routing = { inputs };

    // Precondition (the bug shape): UTF-16 length is UNDER the margin, but the
    // byte size is well OVER the 4 KiB genesis cap.
    expect(JSON.stringify(routing).length).toBeLessThan(ROUTING_SPILL_MARGIN_BYTES);
    expect(enc.encode(JSON.stringify(routing)).length).toBeGreaterThan(4096);

    const blobs: string[] = [];
    const result = spillRoutingInputs(routing, (sha) => blobs.push(sha));

    // They spill, and the resulting routing is under the margin IN BYTES.
    expect(result.spilled.length).toBeGreaterThan(0);
    expect(enc.encode(JSON.stringify(result.routing)).length).toBeLessThan(ROUTING_SPILL_MARGIN_BYTES);
  });

  test("spill order is by byte-length desc then key asc (deterministic)", () => {
    const bigVal = "x".repeat(PER_VALUE_SPILL_BYTES + 100);
    const medVal = "y".repeat(PER_VALUE_SPILL_BYTES + 50);
    const routing = {
      inputs: {
        z_big: bigVal,
        a_med: medVal,
      },
    };
    const spillOrder: string[] = [];
    spillRoutingInputs(routing, (sha) => {
      // We capture sha to check indirectly, but we capture the key via spilled
      spillOrder.push(sha);
    });
    const result = spillRoutingInputs(routing, () => {});
    // z_big is larger → spilled first
    expect(result.spilled[0]!.key).toBe("z_big");
    expect(result.spilled[1]!.key).toBe("a_med");
  });

  test("key tiebreak is alphabetical asc", () => {
    const sameSize = "x".repeat(PER_VALUE_SPILL_BYTES + 1);
    const routing = {
      inputs: {
        c_key: sameSize,
        a_key: sameSize,
        b_key: sameSize,
      },
    };
    const result = spillRoutingInputs(routing, () => {});
    const keys = result.spilled.map((s) => s.key);
    expect(keys[0]).toBe("a_key");
    expect(keys[1]).toBe("b_key");
    expect(keys[2]).toBe("c_key");
  });

  test("non-string input values are never spilled", () => {
    const routing = {
      inputs: {
        num: 42 as unknown as string,
        arr: [] as unknown as string,
        obj: {} as unknown as string,
        str: "x".repeat(PER_VALUE_SPILL_BYTES + 1),
      },
    };
    const result = spillRoutingInputs(routing, () => {});
    // Only 'str' is spilled
    expect(result.spilled.map((s) => s.key)).toEqual(["str"]);
    const inputs = result.routing["inputs"] as Record<string, unknown>;
    expect(inputs["num"]).toBe(42);
    expect(Array.isArray(inputs["arr"])).toBe(true);
  });

  test("structural routing entries (non-inputs keys) are never spilled", () => {
    const bigVal = "x".repeat(PER_VALUE_SPILL_BYTES + 1);
    const routing = {
      budget_override: bigVal,
      max_loops_override: bigVal,
      inputs: { task: "short" },
    };
    const result = spillRoutingInputs(routing, () => {});
    // Nothing spilled: task is short, structural keys never spill
    expect(result.spilled).toHaveLength(0);
    expect(result.routing["budget_override"]).toBe(bigVal);
  });

  test("determinism: same input always produces the same sha set", () => {
    const bigVal = "x".repeat(PER_VALUE_SPILL_BYTES + 1);
    const routing = { inputs: { task: bigVal } };
    const result1 = spillRoutingInputs(routing, () => {});
    const result2 = spillRoutingInputs(routing, () => {});
    expect(result1.spilled[0]!.sha).toBe(result2.spilled[0]!.sha);
  });
});

describe("materializeRouting", () => {
  test("(bug-3) ref-free routing is returned as the SAME object reference (no clone)", () => {
    const routing = { inputs: { x: "plain", y: "text" }, priority: 1 };
    // Bug: current deepResolve always constructs a new object even with no BlobRefs.
    // Fix: fast-path when collectRoutingBlobShas returns empty — return original.
    const result = materializeRouting(routing as unknown as Record<string, unknown>, () => {
      throw new Error("getBlob must not be called for ref-free routing");
    });
    expect(result).toBe(routing);
  });

  test("(b) round-trips a BlobRef back to the exact original string", () => {
    const original = "hello world this is a test value with unicode: \u{1F600}";
    const encoded = enc.encode(original);
    const sha = VALID_SHA;
    const ref = makeBlobRef(sha, encoded.length);
    const routing = { inputs: { msg: ref } };

    const getBlob = (s: string): Uint8Array => {
      if (s === sha) return encoded;
      throw new Error(`unknown sha: ${s}`);
    };

    const materialized = materializeRouting(routing, getBlob);
    expect((materialized["inputs"] as Record<string, unknown>)["msg"]).toBe(original);
  });

  test("passes through non-ref values unchanged", () => {
    const routing = { inputs: { x: "plain", n: 42 }, priority: 1 };
    const materialized = materializeRouting(routing as unknown as Record<string, unknown>, () => {
      throw new Error("should not be called");
    });
    expect((materialized["inputs"] as Record<string, unknown>)["x"]).toBe("plain");
    expect((materialized["inputs"] as Record<string, unknown>)["n"]).toBe(42);
    expect(materialized["priority"]).toBe(1);
  });

  test("resolves nested refs within arrays", () => {
    const sha = VALID_SHA;
    const ref = makeBlobRef(sha, 5);
    const routing = { items: [ref, "plain"] } as unknown as Record<string, unknown>;
    const materialized = materializeRouting(routing, () => enc.encode("hello"));
    expect((materialized["items"] as unknown[])[0]).toBe("hello");
    expect((materialized["items"] as unknown[])[1]).toBe("plain");
  });

  test("throws when getBlob throws (loud failure on missing blob)", () => {
    const sha = VALID_SHA;
    const ref = makeBlobRef(sha, 10);
    const routing = { inputs: { x: ref } };
    expect(() =>
      materializeRouting(routing, () => {
        throw new Error("missing");
      }),
    ).toThrow("missing");
  });
});

describe("collectRoutingBlobShas", () => {
  test("returns empty array when no refs present", () => {
    expect(collectRoutingBlobShas({ inputs: { x: "plain" } })).toEqual([]);
  });

  test("finds a ref directly under routing.inputs", () => {
    const sha = VALID_SHA;
    const routing = { inputs: { task: makeBlobRef(sha, 10) } };
    const shas = collectRoutingBlobShas(routing);
    expect(shas).toContain(sha);
    expect(shas).toHaveLength(1);
  });

  test("finds refs nested deeply", () => {
    const sha1 = "1".repeat(64);
    const sha2 = "2".repeat(64);
    const routing = {
      inputs: {
        a: makeBlobRef(sha1, 10),
        nested: { b: makeBlobRef(sha2, 20) },
      },
    };
    const shas = collectRoutingBlobShas(routing);
    expect(shas).toContain(sha1);
    expect(shas).toContain(sha2);
    expect(shas).toHaveLength(2);
  });

  test("finds refs inside arrays", () => {
    const sha = VALID_SHA;
    const routing = { items: [makeBlobRef(sha, 5)] } as unknown as Record<string, unknown>;
    expect(collectRoutingBlobShas(routing)).toContain(sha);
  });
});

// ---------------------------------------------------------------------------
// Incremental-size determinism: spill result is identical to the pre-fix
// re-stringify behaviour across a range of routing shapes.
// ---------------------------------------------------------------------------

describe("spillRoutingInputs — incremental-size determinism", () => {
  function runSpill(routing: Record<string, unknown>) {
    const shas: string[] = [];
    const result = spillRoutingInputs(routing, (sha) => shas.push(sha));
    return {
      routing: result.routing,
      spilled: result.spilled,
      shas,
    };
  }

  test("(a) no-spill routing produces identical result across two calls", () => {
    const routing = { inputs: { x: "short", y: "also short" } };
    const r1 = runSpill(routing);
    const r2 = runSpill(routing);
    expect(r1.spilled).toHaveLength(0);
    expect(r2.spilled).toHaveLength(0);
    expect(r1.routing).toBe(routing);
    expect(r2.routing).toBe(routing);
  });

  test("(b) single large value spill: sha and ref are identical on repeated calls", () => {
    const bigVal = "x".repeat(PER_VALUE_SPILL_BYTES + 100);
    const routing = { inputs: { task: bigVal } };
    const r1 = runSpill(routing);
    const r2 = runSpill(routing);
    expect(r1.spilled).toHaveLength(1);
    expect(r1.spilled[0]!.sha).toBe(r2.spilled[0]!.sha);
    expect(r1.spilled[0]!.key).toBe("task");
    expect(isBlobRef((r1.routing["inputs"] as Record<string, unknown>)["task"])).toBe(true);
    expect(isBlobRef((r2.routing["inputs"] as Record<string, unknown>)["task"])).toBe(true);
    const ref1 = (r1.routing["inputs"] as Record<string, Record<string, unknown>>)["task"]!;
    const ref2 = (r2.routing["inputs"] as Record<string, Record<string, unknown>>)["task"]!;
    expect(ref1[BLOB_REF_SENTINEL]).toBe(ref2[BLOB_REF_SENTINEL]);
  });

  test("(c) margin-driven multi-spill: spill order and shas are stable", () => {
    const valA = "a".repeat(PER_VALUE_SPILL_BYTES - 1);
    const valB = "b".repeat(PER_VALUE_SPILL_BYTES - 1);
    const valC = "c".repeat(PER_VALUE_SPILL_BYTES - 1);
    const valD = "d".repeat(PER_VALUE_SPILL_BYTES - 1);
    const routing = { inputs: { a: valA, b: valB, c: valC, d: valD } };
    const r1 = runSpill(routing);
    const r2 = runSpill(routing);
    expect(r1.spilled.length).toBeGreaterThan(0);
    expect(r1.spilled.map((s) => s.key)).toEqual(r2.spilled.map((s) => s.key));
    expect(r1.spilled.map((s) => s.sha)).toEqual(r2.spilled.map((s) => s.sha));
    // Result routing is under the margin.
    expect(JSON.stringify(r1.routing).length).toBeLessThan(ROUTING_SPILL_MARGIN_BYTES);
    expect(JSON.stringify(r2.routing).length).toBeLessThan(ROUTING_SPILL_MARGIN_BYTES);
  });

  test("(d) mixed per-value and margin spill: refs match original test expectations", () => {
    const bigVal = "x".repeat(PER_VALUE_SPILL_BYTES + 1);
    const routing = { inputs: { z_big: bigVal, a_med: "y".repeat(PER_VALUE_SPILL_BYTES + 50) } };
    const r1 = runSpill(routing);
    const r2 = runSpill(routing);
    expect(r1.spilled[0]!.key).toBe("a_med"); // largest first: a_med (PER+50) > z_big (PER+1)
    expect(r1.spilled.map((s) => s.key)).toEqual(r2.spilled.map((s) => s.key));
    expect(r1.spilled.map((s) => s.sha)).toEqual(r2.spilled.map((s) => s.sha));
  });

  test("(e) routing stays under margin after incremental tracking (same as full re-stringify)", () => {
    // Build routing just over the margin so exactly some values get spilled.
    const smallish = "x".repeat(PER_VALUE_SPILL_BYTES - 1);
    const inputs: Record<string, string> = {
      a: `a${smallish.slice(1)}`,
      b: `b${smallish.slice(1)}`,
      c: `c${smallish.slice(1)}`,
      d: `d${smallish.slice(1)}`,
    };
    const routing = { inputs };
    const r = runSpill(routing);
    // Result must be under the margin.
    expect(JSON.stringify(r.routing).length).toBeLessThan(ROUTING_SPILL_MARGIN_BYTES);
    // All spilled shas must be stable across calls.
    const r2 = runSpill(routing);
    expect(r.spilled.map((s) => s.sha)).toEqual(r2.spilled.map((s) => s.sha));
  });
});
