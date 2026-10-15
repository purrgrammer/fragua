// Fixture: a handler module reaching the filesystem through the bare `fs`
// specifier instead of `node:fs` — `isBuiltin` must catch it.

// biome-ignore lint/style/useNodejsImportProtocol: the bare specifier is the bypass under test
import { readFileSync } from "fs";

export function makeBareBuiltinHandler(): { kind: string; handler: () => string } {
  return { kind: "bare-builtin", handler: () => readFileSync("/dev/null", "utf8") };
}
