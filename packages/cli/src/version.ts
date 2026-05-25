// Single source for the CLI version. In dev (`bun run …`, uncompiled) the env
// var is normally unset, so this folds to the `-dev` marker. In a compiled
// binary, `scripts/build-bin.ts` passes `--define process.env.FRAGUA_VERSION=…`
// so `bun build` statically replaces the read with the release tag literal.
export const FRAGUA_VERSION = process.env["FRAGUA_VERSION"] ?? "0.0.0-dev";
