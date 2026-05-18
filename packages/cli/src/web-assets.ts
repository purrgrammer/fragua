// Web bundle embedding for `bun build --compile`.
//
// In dev (`bun run packages/cli/bin/swarm.ts`), this file exports an empty
// map and the CLI falls back to reading `packages/web/dist/` from disk via
// `ensureWebBundle()`.
//
// At binary build time, `scripts/build-bin.ts` overwrites this file with
// `import asset_N from "../../web/dist/<path>" with { type: "file" }` lines
// for every dist file plus a populated `EMBEDDED_WEB_ASSETS` map. Bun
// inlines those assets into the compiled executable; at runtime the
// imported strings are virtual paths under `/$bunfs/root/` that
// `Bun.file(path)` resolves to the embedded bytes. The stub is restored
// after a successful compile so the source tree stays diff-clean.

export const EMBEDDED_WEB_ASSETS: Readonly<Record<string, string>> = {};
