// Canonical stringify — pinning the deterministic-output contract that
// `argsHash` / `idempotencyKey` rely on. ARCHITECTURE.md §1.1.

import { describe, expect, test } from "bun:test";
import { CanonicalStringifyError, canonicalStringify } from "../../src/handler/canonical-stringify.ts";

describe("canonicalStringify — basics", () => {
  test("primitives match JSON.stringify modulo strict number rules", () => {
    expect(canonicalStringify(null)).toBe("null");
    expect(canonicalStringify(true)).toBe("true");
    expect(canonicalStringify(false)).toBe("false");
    expect(canonicalStringify(0)).toBe("0");
    expect(canonicalStringify(-1.5)).toBe("-1.5");
    expect(canonicalStringify("hi")).toBe('"hi"');
  });

  test("arrays preserve order; objects sort keys", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("nested structures sort each level independently", () => {
    const a = { z: { y: 1, x: 2 }, a: [3, { c: 1, b: 2 }] };
    const b = { a: [3, { b: 2, c: 1 }], z: { x: 2, y: 1 } };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });
});

describe("canonicalStringify — Unicode normalisation", () => {
  // U+00E9 (precomposed é, NFC) vs U+0065 U+0301 (e + combining acute, NFD).
  // Same logical character, two different byte sequences. After NFC
  // normalisation both should hash identically.
  const NFC = "café"; // 4 code units
  const NFD = "café"; // 5 code units

  test("string values: NFC and NFD inputs produce the same canonical output", () => {
    expect(NFC).not.toBe(NFD); // sanity: they differ at the byte level
    expect(canonicalStringify(NFC)).toBe(canonicalStringify(NFD));
  });

  test("string values inside arrays normalise too", () => {
    expect(canonicalStringify([NFD, NFD])).toBe(canonicalStringify([NFC, NFC]));
  });

  test("object keys are normalised and then sorted", () => {
    const a: Record<string, number> = {};
    a[NFC] = 1;
    a["x"] = 2;
    const b: Record<string, number> = {};
    b[NFD] = 1;
    b["x"] = 2;
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  test("an object with NFC and NFD versions of the same key throws", () => {
    const obj: Record<string, number> = {};
    obj[NFC] = 1;
    obj[NFD] = 2;
    // Sanity: the JS object actually has two distinct keys.
    expect(Object.keys(obj)).toHaveLength(2);
    expect(() => canonicalStringify(obj)).toThrow(CanonicalStringifyError);
    expect(() => canonicalStringify(obj)).toThrow(/duplicate key after NFC normalisation/);
  });
});

describe("canonicalStringify — rejected inputs", () => {
  test("undefined", () => {
    expect(() => canonicalStringify(undefined)).toThrow(CanonicalStringifyError);
  });

  test("non-finite numbers", () => {
    expect(() => canonicalStringify(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalStringify(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalStringify(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  test("BigInt", () => {
    expect(() => canonicalStringify(1n)).toThrow(/bigint/);
  });

  test("Symbol", () => {
    expect(() => canonicalStringify(Symbol("x"))).toThrow(/symbol/);
  });

  test("function", () => {
    expect(() => canonicalStringify(() => 1)).toThrow(/function/);
  });

  test("Date — explicit reject (not silent {})", () => {
    expect(() => canonicalStringify(new Date(0))).toThrow(/Date is not serialisable/);
  });

  test("Buffer / Uint8Array / DataView — explicit reject (not silent {})", () => {
    expect(() => canonicalStringify(new Uint8Array([1, 2, 3]))).toThrow(/typed arrays/);
    expect(() => canonicalStringify(new Int32Array([1, 2]))).toThrow(/typed arrays/);
    expect(() => canonicalStringify(new DataView(new ArrayBuffer(4)))).toThrow(/typed arrays/);
  });

  test("ArrayBuffer — explicit reject", () => {
    expect(() => canonicalStringify(new ArrayBuffer(4))).toThrow(/ArrayBuffer/);
  });

  test("cyclic references", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalStringify(a)).toThrow(/cyclic/);
  });
});

describe("canonicalStringify — stability corpus", () => {
  // Each row is a list of structurally-equal-but-textually-distinct JS
  // representations. All entries in a row must canonicalise to the same
  // string. Cross-row entries must canonicalise differently.
  const corpus: { name: string; reps: unknown[] }[] = [
    {
      name: "key reorder",
      reps: [
        { a: 1, b: 2, c: 3 },
        { c: 3, b: 2, a: 1 },
        { b: 2, c: 3, a: 1 },
      ],
    },
    {
      name: "NFC vs NFD strings",
      reps: ["café", "café"],
    },
    {
      name: "number canonical forms via JSON.stringify",
      reps: [1, 1.0, 1],
    },
    {
      name: "nested object key reorder",
      reps: [
        { x: { a: 1, b: 2 }, y: [3, 4] },
        { y: [3, 4], x: { b: 2, a: 1 } },
      ],
    },
  ];

  test("each row's representations all hash identically", () => {
    for (const row of corpus) {
      const [first, ...rest] = row.reps.map((r) => canonicalStringify(r));
      for (const r of rest) {
        expect(r).toBe(first!);
      }
    }
  });

  test("distinct rows produce distinct hashes (no accidental collisions)", () => {
    const firsts = corpus.map((row) => canonicalStringify(row.reps[0]));
    expect(new Set(firsts).size).toBe(firsts.length);
  });
});
