import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newScheduleId } from "../src/schedule-id.ts";

const PACKAGES = join(import.meta.dir, "..", "..");

describe("newScheduleId", () => {
  test("newScheduleId is sch_ + 6 base-36 chars", () => {
    expect(newScheduleId()).toMatch(/^sch_[0-9a-z]{6}$/);
  });

  test("newScheduleId is unique across many mints", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newScheduleId()));
    expect(ids.size).toBe(1000);
  });

  test("server and cli define no local newScheduleId", () => {
    for (const rel of ["server/src/index.ts", "cli/src/store-client.ts"]) {
      const src = readFileSync(join(PACKAGES, rel), "utf8");
      expect(src, `${rel} re-declares newScheduleId — import it from @fragua/store`).not.toMatch(
        /function\s+newScheduleId\b/,
      );
    }
  });
});
