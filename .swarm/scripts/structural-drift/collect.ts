#!/usr/bin/env bun
// structural-drift/collect.ts — deterministic inventory for structural-drift.dot's
// `drift` and `propose_patch` nodes. Narrower than the original introspect
// collector: only the surfaces where literal code↔doc cross-reference makes
// sense (schema, event taxonomy, handler contract, intent fold + the docs
// that mirror them). Output is a single JSON document on stdout, consumed
// downstream via `$collect.output`.
//
// Sections:
//   1. contract_files       — line count + sha256(first 12) per surface
//   2. taxonomy             — verbatim union literals from swarm-events.ts
//   3. schema_sql           — verbatim contents of schema.sql
//   4. recent_commits       — last 30 across the repo
//   5. contract_file_history — last 50 per contract file (for AGENTS.md rule #1)
//   6. doc_code_blocks      — fenced typescript / dot blocks in the structural docs
//
// Narrative surfaces (README "delivers today", proposals, swarm-* skills) live
// in narrative-drift/collect.ts.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONTRACT_FILES = [
  "packages/store/src/schema.sql",
  "packages/types/src/swarm-events.ts",
  "packages/core/src/handler/types.ts",
  "packages/core/src/handler/intent-fold.ts",
  "docs/SPEC.md",
  "docs/ARCHITECTURE.md",
  "docs/handler-contract.md",
  "docs/intent-fold.md",
] as const;

const DOC_FILES_FOR_CODE_BLOCKS = [
  "docs/SPEC.md",
  "docs/ARCHITECTURE.md",
  "docs/handler-contract.md",
  "docs/intent-fold.md",
] as const;

const RELEVANT_BLOCK_LANGUAGES = new Set(["typescript", "ts", "tsx", "dot"]);

interface FileSnapshot {
  path: string;
  exists: boolean;
  lines: number;
  sha256_12: string;
}

function snapshotFile(rel: string): FileSnapshot {
  const abs = resolve(process.cwd(), rel);
  if (!existsSync(abs)) {
    return { path: rel, exists: false, lines: 0, sha256_12: "" };
  }
  const buf = readFileSync(abs);
  const text = buf.toString("utf8");
  const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const sha = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  return { path: rel, exists: true, lines, sha256_12: sha };
}

function readOrEmpty(rel: string): string {
  const abs = resolve(process.cwd(), rel);
  if (!existsSync(abs)) return "";
  return readFileSync(abs, "utf8");
}

function git(args: string[]): string {
  try {
    return execSync(`git ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

interface Taxonomy {
  run_statuses: string[];
  pause_reasons: string[];
  halt_reasons: string[];
  quarantine_reasons: string[];
  intent_types: string[];
  fact_types: string[];
  daemon_event_types: string[];
}

function extractStringUnion(src: string, typeName: string): string[] {
  const re = new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*([\\s\\S]*?);`, "m");
  const m = src.match(re);
  if (!m) return [];
  const body = m[1] ?? "";
  return Array.from(body.matchAll(/"([^"]+)"/g)).map((x) => x[1] as string);
}

function extractUnionBody(src: string, typeName: string): string {
  const start = src.search(new RegExp(`export\\s+type\\s+${typeName}\\s*=`, "m"));
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i);
  }
  return src.slice(start);
}

function extractDiscriminatorTypes(body: string, prefix: string): string[] {
  const out = new Set<string>();
  const re = new RegExp(`type:\\s*"(${prefix.replace(/\./g, "\\.")}[a-z_]+)"`, "g");
  for (const m of body.matchAll(re)) out.add(m[1] as string);
  return [...out];
}

function extractTaxonomy(): Taxonomy {
  const src = readOrEmpty("packages/types/src/swarm-events.ts");
  return {
    run_statuses: extractStringUnion(src, "RunStatus"),
    pause_reasons: extractStringUnion(src, "PauseReason"),
    halt_reasons: extractStringUnion(src, "HaltReason"),
    quarantine_reasons: extractStringUnion(src, "QuarantineReason"),
    intent_types: extractDiscriminatorTypes(extractUnionBody(src, "IntentEvent"), "intent."),
    fact_types: extractDiscriminatorTypes(extractUnionBody(src, "FactEvent"), "fact."),
    daemon_event_types: extractDiscriminatorTypes(extractUnionBody(src, "DaemonEvent"), "daemon."),
  };
}

interface CodeBlock {
  file: string;
  line_start: number;
  language: string;
  content: string;
}

function extractCodeBlocks(rel: string): CodeBlock[] {
  const src = readOrEmpty(rel);
  if (!src) return [];
  const lines = src.split("\n");
  const blocks: CodeBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const m = line.match(/^```(\w+)/);
    if (!m) {
      i++;
      continue;
    }
    const lang = (m[1] ?? "").toLowerCase();
    const start = i + 1;
    const buf: string[] = [];
    i++;
    while (i < lines.length && !((lines[i] ?? "").startsWith("```"))) {
      buf.push(lines[i] ?? "");
      i++;
    }
    if (RELEVANT_BLOCK_LANGUAGES.has(lang)) {
      blocks.push({ file: rel, line_start: start, language: lang, content: buf.join("\n") });
    }
    i++;
  }
  return blocks;
}

function recentCommits(n: number): string[] {
  const out = git(["log", `-${n}`, "--oneline", "--no-decorate"]);
  return out ? out.split("\n") : [];
}

function fileHistory(path: string, n: number): string[] {
  const out = git(["log", `-${n}`, "--format=%h %s", "--", path]);
  return out ? out.split("\n") : [];
}

const focus = process.argv.slice(2).join(" ").trim();

const snapshot = {
  collected_at: new Date().toISOString(),
  cwd: process.cwd(),
  git_head: git(["rev-parse", "HEAD"]) || null,
  focus: focus || null,
  contract_files: CONTRACT_FILES.map(snapshotFile),
  taxonomy: extractTaxonomy(),
  schema_sql: readOrEmpty("packages/store/src/schema.sql"),
  doc_code_blocks: DOC_FILES_FOR_CODE_BLOCKS.flatMap(extractCodeBlocks),
  recent_commits: recentCommits(30),
  contract_file_history: Object.fromEntries(
    CONTRACT_FILES.map((p) => [p, fileHistory(p, 50)]),
  ),
};

process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
