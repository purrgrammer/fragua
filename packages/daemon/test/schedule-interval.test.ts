import { describe, expect, test } from "bun:test";
import { InvalidScheduleIntervalError, parseScheduleInterval, SCHEDULE_INTERVALS } from "../src/schedule-interval.ts";

describe("parseScheduleInterval", () => {
  test("parses the supported shorthands to ms; rejects everything else", () => {
    expect(parseScheduleInterval("30m")).toBe(30 * 60 * 1000);
    expect(parseScheduleInterval("1h")).toBe(60 * 60 * 1000);
    expect(parseScheduleInterval("6h")).toBe(6 * 60 * 60 * 1000);
    expect(parseScheduleInterval("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseScheduleInterval("3d")).toBe(3 * 24 * 60 * 60 * 1000);
    expect(parseScheduleInterval("7d")).toBe(7 * 24 * 60 * 60 * 1000);

    for (const bad of ["5m", "1d", "2d", "30s", "60", "", "1H", " 1h ", "0h", "1.5h", "8d"]) {
      expect(() => parseScheduleInterval(bad)).toThrow(InvalidScheduleIntervalError);
    }

    expect(SCHEDULE_INTERVALS).toEqual(["30m", "1h", "6h", "24h", "3d", "7d"]);
  });
});
