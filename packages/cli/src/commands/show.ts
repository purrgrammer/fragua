// `fragua show <file.fragua>` — validate a bundle and summarize it WITHOUT a
// store (docs/proposals/bundles.md §4). Structural + per-blob integrity checks,
// then replay each run's event log into a derived `run_state` for a one-line
// summary. Read-only, no `--db`.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertBundleManifest,
  BUNDLE_VERSION,
  type BundleManifest,
  blobPath,
  decodeJsonl,
  deriveRunState,
  MANIFEST_ENTRY,
  readTar,
  runEventsPath,
  sha256Hex,
} from "@fragua/store";
import chalk from "chalk";

export interface ShowOptions {
  bundle: string;
}

type LoggedEvent = { seq: number; type: string; payload: unknown; ts: number };

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Parse, integrity-check, and summarize a `.fragua` bundle. Returns 0 when the
 *  bundle is structurally sound and every blob hashes, else 1. */
export function showCommand(opts: ShowOptions): Promise<number> {
  const src = resolve(opts.bundle);
  if (!existsSync(src)) {
    console.error(chalk.red(`show: no bundle at ${src}`));
    return Promise.resolve(1);
  }
  let entries: { name: string; data: Uint8Array }[];
  try {
    entries = readTar(readFileSync(src));
  } catch (err) {
    console.error(chalk.red(`show: not a readable bundle — ${(err as Error).message}`));
    return Promise.resolve(1);
  }
  const byName = new Map(entries.map((e) => [e.name, e.data] as const));

  const manifestData = byName.get(MANIFEST_ENTRY);
  if (manifestData == null) {
    console.error(chalk.red("show: manifest.json missing — not a fragua bundle"));
    return Promise.resolve(1);
  }
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestData)) as BundleManifest;
    assertBundleManifest(manifest);
  } catch (err) {
    console.error(chalk.red(`show: malformed manifest — ${(err as Error).message}`));
    return Promise.resolve(1);
  }

  const versionOk = manifest.bundleVersion === BUNDLE_VERSION;
  console.log(
    chalk.bold(`bundle ${chalk.cyan(src.split("/").at(-1) ?? src)}`) +
      chalk.dim(
        `  fragua ${manifest.fraguaVersion}  ·  bundle v${manifest.bundleVersion}` +
          `  ·  contract v${manifest.contractVersion}  ·  schema v${manifest.schemaVersion}`,
      ),
  );
  if (!versionOk) {
    console.warn(
      chalk.yellow(
        `  ⚠ bundleVersion ${manifest.bundleVersion} — this build reads v${BUNDLE_VERSION}; summary may be partial`,
      ),
    );
  }

  // Blob integrity — every manifest blob present and hashing to its name.
  let blobsOk = 0;
  let blobsBad = 0;
  for (const b of manifest.blobs) {
    const data = byName.get(blobPath(b.sha256));
    if (data == null || sha256Hex(data) !== b.sha256) blobsBad++;
    else blobsOk++;
  }
  console.log(
    chalk.dim(
      `  ${manifest.runs.length} run(s)  ·  ${manifest.workflows.length} workflow(s)  ·  ` +
        `${blobsOk}/${manifest.blobs.length} blob(s) intact`,
    ) + (blobsBad > 0 ? chalk.red(`  ✗ ${blobsBad} corrupt`) : ""),
  );

  for (const r of manifest.runs) {
    const evData = byName.get(runEventsPath(r.runId));
    if (evData == null) {
      console.log(`  ${chalk.red("✗")} ${r.runId}  ${chalk.dim("(no events.jsonl)")}`);
      continue;
    }
    try {
      const events = decodeJsonl(evData) as LoggedEvent[];
      const d = deriveRunState(r.runId, events);
      const first = events.reduce((m, e) => Math.min(m, e.ts), Number.POSITIVE_INFINITY);
      const last = events.reduce((m, e) => Math.max(m, e.ts), 0);
      const cost = d.metrics.totalCostUsd;
      console.log(
        `  ${chalk.green("•")} ${chalk.bold(r.runId)}  ${chalk.cyan(d.status)}` +
          chalk.dim(
            `  ·  ${r.events} events  ·  ${r.messages} msgs  ·  $${cost.toFixed(4)}` +
              `  ·  ${d.metrics.billedTokens} tok  ·  ${fmtDuration(last - first)}`,
          ),
      );
    } catch (err) {
      console.log(`  ${chalk.red("✗")} ${r.runId}  ${chalk.red(`(replay failed: ${(err as Error).message})`)}`);
    }
  }

  return Promise.resolve(versionOk && blobsBad === 0 ? 0 : 1);
}
