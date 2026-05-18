#!/usr/bin/env bun
// Compile the swarm CLI to a single executable via `bun build --compile`.
//
// Steps:
//   1. Build the web bundle (`bun run --filter @swarm/web build`). The
//      compile step embeds whatever is at `packages/web/dist/` at this
//      moment, so building first guarantees the binary ships fresh UI.
//   2. Regenerate `packages/cli/src/web-assets.ts` with a `with { type: "file" }`
//      import for every file in `packages/web/dist/` (source maps excluded).
//      Bun's bundler inlines those files into the executable and the
//      generated map (`url path → virtual /$bunfs/root/… path`) is what
//      the server hands to `Bun.file()` at request time.
//   3. `bun build --compile --target=bun packages/cli/bin/swarm.ts
//      --outfile <out>`.
//   4. Restore the empty `web-assets.ts` stub so the source tree stays
//      diff-clean. We write a known-good stub rather than `git checkout`
//      so the script works on dirty checkouts, before the stub is
//      committed, and in CI worktrees. The restore runs in a finally so
//      a failed compile still leaves the working copy in a clean state.
//
// Defaults: outfile=`dist/swarm` at the repo root. Override with `--out
// <path>`. `--keep-assets` skips the restore (debugging).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const WEB_DIST_DIR = join(REPO_ROOT, "packages/web/dist");
const WEB_ASSETS_FILE = join(REPO_ROOT, "packages/cli/src/web-assets.ts");
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/bin/swarm.ts");
const DEFAULT_OUTFILE = join(REPO_ROOT, "dist/swarm");

const STUB_CONTENTS = `// Web bundle embedding for \`bun build --compile\`.
//
// In dev (\`bun run packages/cli/bin/swarm.ts\`), this file exports an empty
// map and the CLI falls back to reading \`packages/web/dist/\` from disk via
// \`ensureWebBundle()\`.
//
// At binary build time, \`scripts/build-bin.ts\` overwrites this file with
// \`import asset_N from "../../web/dist/<path>" with { type: "file" }\` lines
// for every dist file plus a populated \`EMBEDDED_WEB_ASSETS\` map. Bun
// inlines those assets into the compiled executable; at runtime the
// imported strings are virtual paths under \`/$bunfs/root/\` that
// \`Bun.file(path)\` resolves to the embedded bytes. The stub is restored
// after a successful compile so the source tree stays diff-clean.

export const EMBEDDED_WEB_ASSETS: Readonly<Record<string, string>> = {};
`;

const args = parseArgs(process.argv.slice(2));
const outfile = resolve(args.out ?? DEFAULT_OUTFILE);
const keepAssets = args.keepAssets;

console.log(`swarm: compiling binary → ${relative(process.cwd(), outfile)}`);

try {
  // 1. Build the web bundle. We always rebuild rather than relying on
  //    mtime checks — the cost is ~5s and it guarantees the embedded
  //    bytes match the source tree at compile time.
  console.log("  [1/3] building web bundle (vite)…");
  await runOrExit("bun", ["run", "--filter", "@swarm/web", "build"], { cwd: REPO_ROOT });

  // 2. Regenerate the embedded-assets manifest. Walk the dist tree,
  //    write one `import` per file plus the populated map.
  console.log("  [2/3] regenerating web-assets manifest…");
  if (!existsSync(WEB_DIST_DIR)) {
    console.error(`  no dist at ${WEB_DIST_DIR} — vite build did not produce output`);
    process.exit(1);
  }
  const files = listDistFiles(WEB_DIST_DIR);
  writeFileSync(WEB_ASSETS_FILE, renderManifest(files));
  console.log(`         embedded ${files.length} files`);

  // 3. Compile. --target=bun is the default but spelled out so the intent
  //    is obvious. `--minify` shaves ~30% off the binary; `--sourcemap`
  //    omitted because the use case is a shippable artefact, not a
  //    debuggable one.
  console.log("  [3/3] bun build --compile…");
  mkdirSync(dirname(outfile), { recursive: true });
  await runOrExit("bun", ["build", "--compile", "--target=bun", "--minify", CLI_ENTRY, "--outfile", outfile], {
    cwd: REPO_ROOT,
  });

  const sizeMb = (statSync(outfile).size / 1024 / 1024).toFixed(1);
  console.log(`✓ wrote ${relative(process.cwd(), outfile)} (${sizeMb} MB)`);
} finally {
  if (!keepAssets) {
    // Restore the empty stub. Writing a known-good string rather than
    // shelling out to `git checkout` keeps the script working on dirty
    // checkouts and before the stub is first committed.
    writeFileSync(WEB_ASSETS_FILE, STUB_CONTENTS);
  }
}

interface CliArgs {
  out?: string;
  keepAssets: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { keepAssets: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") {
      const next = argv[++i];
      if (next == null) {
        console.error("--out requires a path");
        process.exit(1);
      }
      out.out = next;
    } else if (a === "--keep-assets") {
      out.keepAssets = true;
    } else if (a === "--help" || a === "-h") {
      console.log("usage: build-bin.ts [--out <path>] [--keep-assets]");
      console.log("  --out PATH      output binary path (default dist/swarm)");
      console.log("  --keep-assets   skip restoring the web-assets stub after compile");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function listDistFiles(root: string): string[] {
  const out: string[] = [];
  walk(root, root, out);
  // Stable order so the generated file is reproducible across runs.
  return out.sort();
}

function walk(absRoot: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(absRoot, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    // Skip source maps — they roughly double the binary size and aren't
    // needed at runtime. Drop here if the dev wants them; for now, no.
    if (entry.name.endsWith(".map")) continue;
    out.push(relative(absRoot, full));
  }
}

function renderManifest(files: readonly string[]): string {
  // Import paths are relative from `packages/cli/src/web-assets.ts` to
  // `packages/web/dist/<file>` = `../../web/dist/<file>`. Use forward
  // slashes regardless of host OS (Windows works too).
  const lines: string[] = [
    "// AUTO-GENERATED by packages/cli/scripts/build-bin.ts. Do not edit.",
    "// Regenerated before `bun build --compile`, restored to the empty",
    "// stub after a successful compile.",
    "",
  ];
  files.forEach((f, i) => {
    const rel = `../../web/dist/${f.split("\\").join("/")}`;
    lines.push(`import asset_${i} from ${JSON.stringify(rel)} with { type: "file" };`);
  });
  lines.push("");
  lines.push("export const EMBEDDED_WEB_ASSETS: Readonly<Record<string, string>> = {");
  files.forEach((f, i) => {
    const key = f.split("\\").join("/");
    lines.push(`  ${JSON.stringify(key)}: asset_${i},`);
  });
  lines.push("};");
  lines.push("");
  return lines.join("\n");
}

function runOrExit(cmd: string, args: string[], opts: { cwd: string }): Promise<void> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: "inherit" });
    child.on("close", (code) => {
      if (code !== 0) {
        console.error(`  ✗ ${cmd} ${args.join(" ")} exited ${code}`);
        process.exit(code ?? 1);
      }
      res();
    });
    child.on("error", (err) => {
      console.error(`  ✗ ${cmd} failed to spawn: ${err.message}`);
      process.exit(1);
    });
  });
}
