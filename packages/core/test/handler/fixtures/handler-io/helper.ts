import { readFileSync } from "node:fs";

export function readConfig(): string {
  return readFileSync("/dev/null", "utf8");
}
