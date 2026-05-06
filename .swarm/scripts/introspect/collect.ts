#!/usr/bin/env bun
// introspect/collect.ts — deterministic inventory for introspect.dot's
// `drift` and `synthesize` nodes. Replaces the original codergen
// `collect` node, which was a haiku acting as a glorified shell
// scripter. Output is a single JSON document on stdout, consumed by
// downstream nodes via `$collect.output`.
//
// Sections:
//   1. contract_files       — line count + sha256(first 12) per surface
//   2. taxonomy             — verbatim union literals from swarm-events.ts
//   3. schema_sql           — verbatim contents of schema.sql
//   4. readme               — verbatim 'delivers today' / 'does not' sections
//   5. proposals            — front-matter (title/status/maturity) per file
//   6. recent_commits       — last 30 across the repo
//   7. contract_file_history — last 50 per contract file
//   8. skill_files          — line count + sha256(first 12) per swarm-* skill

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  "docs/PENDING.md",
  "README.md",
  "docs/proposals/README.md",
] as const;

const SKILL_FILES = [
  ".agents/skills/swarm-author/SKILL.md",
  ".agents/skills/swarm-run/SKILL.md",
  ".agents/skills/swarm-debug/SKILL.md",
] as const;

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

function extractReadmeSection(src: string, heading: string): string {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

interface Proposal {
  file: string;
  title: string | null;
  status: string | null;
  maturity: string | null;
  last_reviewed: string | null;
}

function parseFrontMatter(src: string): Record<string, string> {
  if (!src.startsWith("---")) return {};
  const end = src.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = src.slice(3, end).trim();
  const out: Record<string, string> = {};
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function collectProposals(): Proposal[] {
  const dir = resolve(process.cwd(), "docs/proposals");
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md");
  entries.sort();
  return entries.map((f) => {
    const rel = `docs/proposals/${f}`;
    const fm = parseFrontMatter(readOrEmpty(rel));
    return {
      file: rel,
      title: fm.title ?? null,
      status: fm.status ?? null,
      maturity: fm.maturity ?? null,
      last_reviewed: fm["last-reviewed"] ?? null,
    };
  });
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
  readme: {
    delivers_today: extractReadmeSection(readOrEmpty("README.md"), "## What swarm delivers today"),
    does_not_deliver: extractReadmeSection(
      readOrEmpty("README.md"),
      "## What swarm does not deliver today",
    ),
  },
  proposals: collectProposals(),
  recent_commits: recentCommits(30),
  contract_file_history: Object.fromEntries(
    CONTRACT_FILES.map((p) => [p, fileHistory(p, 50)]),
  ),
  skill_files: SKILL_FILES.map(snapshotFile),
};

process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
