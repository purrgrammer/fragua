#!/usr/bin/env bun
// apply.ts — apply a list of edit blocks to a single doc.
//
// Usage:
//   bun apply.ts <doc-path> <patch-json>
//
// where <patch-json> is a JSON array of:
//   { reason, old_string, new_string }     — apply this edit
//   { reason, skipped: true, why }          — skip (ambiguous anchor)
//
// Behavior:
//   - Each block's old_string is replaced with new_string in the doc.
//   - old_string must appear EXACTLY ONCE in the doc (unique anchor);
//     ambiguous matches are reported as failures and skipped.
//   - Edits are applied sequentially against the in-memory buffer;
//     later blocks see the result of earlier blocks.
//   - The doc is rewritten in place only if at least one block applied.
//
// Output (stdout):
//   APPLIED: <N>
//   SKIPPED: <N>
//   FAILURES:
//     - <reason>: old_string not found | ambiguous (M matches)
//
// Exit code:
//   0 — at least one block applied successfully, OR everything was a no-op skip
//   1 — any FAILURE row (apply.ts couldn't make a requested edit)

import fs from "node:fs";

type Edit = { reason: string; old_string: string; new_string: string };
type Skip = { reason: string; skipped: true; why: string };
type Block = Edit | Skip;

const [, , docPath, patchJsonArg] = process.argv;
if (!docPath || patchJsonArg === undefined) {
  console.error("Usage: bun apply.ts <doc-path> <patch-json>");
  process.exit(2);
}

let blocks: Block[];
try {
  blocks = JSON.parse(patchJsonArg);
  if (!Array.isArray(blocks)) {
    throw new Error("patch-json must be an array");
  }
} catch (err) {
  console.error(`apply.ts: invalid patch-json: ${(err as Error).message}`);
  process.exit(2);
}

if (!fs.existsSync(docPath)) {
  console.error(`apply.ts: doc not found: ${docPath}`);
  process.exit(2);
}

let content = fs.readFileSync(docPath, "utf8");
let applied = 0;
let skipped = 0;
const failures: string[] = [];

for (const b of blocks) {
  if ("skipped" in b && b.skipped) {
    skipped++;
    continue;
  }

  const edit = b as Edit;

  const first = content.indexOf(edit.old_string);
  if (first === -1) {
    failures.push(`${edit.reason}: old_string not found`);
    continue;
  }

  const second = content.indexOf(edit.old_string, first + 1);
  if (second !== -1) {
    let count = 2;
    let pos = second;
    while (true) {
      pos = content.indexOf(edit.old_string, pos + 1);
      if (pos === -1) break;
      count++;
    }
    failures.push(`${edit.reason}: old_string is ambiguous (${count} matches)`);
    continue;
  }

  content = content.slice(0, first) + edit.new_string + content.slice(first + edit.old_string.length);
  applied++;
}

if (applied > 0) {
  fs.writeFileSync(docPath, content);
}

console.log(`APPLIED: ${applied}`);
console.log(`SKIPPED: ${skipped}`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
