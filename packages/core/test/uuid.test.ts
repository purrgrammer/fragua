import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { isUuidv7, uuidv7 } from "../src/uuid.ts";

describe("uuidv7", () => {
  test("matches the canonical 8-4-4-4-12 hex layout", () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("version nibble is 7 and variant nibble is 8/9/a/b", () => {
    for (let i = 0; i < 64; i++) {
      const id = uuidv7();
      expect(id[14]).toBe("7");
      expect("89ab").toContain(id[19]!);
    }
  });

  test("is lexically sortable by creation time across 1ms boundaries", async () => {
    const a = uuidv7();
    await new Promise((r) => setTimeout(r, 2));
    const b = uuidv7();
    await new Promise((r) => setTimeout(r, 2));
    const c = uuidv7();
    expect([a, b, c].sort()).toEqual([a, b, c]);
  });

  test("isUuidv7 accepts every freshly-minted id", () => {
    for (let i = 0; i < 32; i++) {
      expect(isUuidv7(uuidv7())).toBe(true);
    }
  });

  test("isUuidv7 rejects v4 and other non-v7 strings", () => {
    expect(isUuidv7("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(isUuidv7("not-a-uuid")).toBe(false);
    expect(isUuidv7("01934e2c-7b3a-7000-7000-000000000000")).toBe(false); // bad variant
  });

  test("property — random calls always produce valid v7 ids", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 16 }), (n) => {
        for (let i = 0; i < n; i++) {
          expect(isUuidv7(uuidv7())).toBe(true);
        }
      }),
      { numRuns: 32 },
    );
  });
});
