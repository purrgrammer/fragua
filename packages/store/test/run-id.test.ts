// newRunId: a true ULID — collision-safe + time-sortable. Lives in
// @fragua/store so the server route AND the daemon schedule dispatcher mint
// the same id shape (a run id is portable identity for db-import).

import { describe, expect, test } from "bun:test";
import { newRunId } from "../src/run-id.ts";

describe("newRunId", () => {
  test("is 26 lowercase Crockford-base32 chars (10 time + 16 random)", () => {
    const id = newRunId();
    expect(id).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
  });

  test("is unique across many mints", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newRunId()));
    expect(ids.size).toBe(10_000);
  });

  test("time component sorts by creation order", () => {
    const a = newRunId();
    // Advance the clock past a millisecond boundary so the 10-char time
    // prefix strictly increases.
    const start = Date.now();
    while (Date.now() === start) {
      /* spin <1ms */
    }
    const b = newRunId();
    // Lexical compare of the time prefixes (first 10 chars) is monotonic.
    expect(b.slice(0, 10) >= a.slice(0, 10)).toBe(true);
  });
});
