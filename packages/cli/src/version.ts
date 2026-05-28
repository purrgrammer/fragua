// Single source for the CLI version.
//
// Two read paths:
//
//   - Compiled binary: `scripts/build-bin.ts` passes
//     `--define process.env.FRAGUA_VERSION=<v>` to `bun build`, so the
//     read site below is folded to a string literal at build time and
//     the dev fallback is dead code.
//   - Dev (`bun run packages/cli/bin/fragua.ts …`): the env var is
//     unset, so we resolve the root `package.json` from this file's
//     directory and report its `version`. Same source of truth the
//     build script consults — no more `0.0.0-dev` in dev output.
//
// Both paths fall back to `"0.0.0-dev"` if reading fails (defensive —
// the file is on disk in dev and the env-var-folded path can't fail).

import { readFileSync } from "node:fs";
import { join } from "node:path";

function readDevVersion(): string {
  try {
    const here = import.meta.dirname;
    if (typeof here !== "string" || here.length === 0) return "0.0.0-dev";
    // packages/cli/src/version.ts → repo root: ../../../package.json
    const raw = readFileSync(join(here, "../../../package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export const FRAGUA_VERSION = process.env["FRAGUA_VERSION"] ?? readDevVersion();
