#!/usr/bin/env bun
// drift/narrative.ts — deterministic inventory for the drift workflow's
// narrative surface, where drift is reasoning-heavy rather than literal:
// project status claims, proposal hygiene, and per-skill rot. Emits a single
// JSON document on stdout for `analyze` to read off the shared `drift` thread.
//
// Sections:
//   1. status              — verbatim 'delivers today' / 'does not deliver' sections from STATUS.md and README.md (whichever has them)
//   2. proposals           — front-matter (title/status/maturity/last_reviewed) per proposal
//   3. skills              — per generic skill (operate / postmortem / workflows): path, name, frontmatter description, lines + sha256_12, target_hint.
//                            These document fragua's own universal surface. The other skills
//                            (frontend / design / backend) are repo-specific to fragua itself — their drift is not in scope.
//
// Structural surfaces (schema, event taxonomy, handler contract, intent fold,
// doc code blocks, recent commits) live in drift/structural.ts.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const SKILL_ROOTS = [".agents/skills"] as const;

// Hints describe the code surface each skill is *supposed to document*, so the
// fan-out subagent has a starting point without re-discovering it. The audit
// node's dispatcher passes these to per-skill subagents verbatim.
const SKILL_TARGET_HINTS: Record<string, string> = {
  workflows:
    "YAML workflow authoring — steps / next / on / routes / inputs / defaults, the four terminal mechanisms, goal-gate vs edge-cycle loops, validator codes. Cross-reference packages/core/src/parser/yaml.ts, packages/core/src/engine/{validator,substitution}.ts, packages/core/src/types/graph.ts.",
  operate:
    "Operator HTTP routes (POST /runs/:id/{steer,pause,cancel,hitl,resume,unquarantine,priority,budget}) — cross-reference packages/server/src/store/routes.ts and runs-routes.ts; flag examples whose body shape would 4xx.",
  postmortem:
    "Event taxonomy / halt reasons / quarantine reasons / payload field names — cross-reference packages/types/src/events.ts. Verify §4.1 fact-type table, §8 halt + paused statuses, §8.1 schedule daemon-events, §8.2 subagent observability events match current literals.",
};

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

function extractMarkdownSection(src: string, heading: string): string {
  if (!src) return "";
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

interface Skill extends FileSnapshot {
  name: string;
  description: string | null;
  target_hint: string | null;
}

function collectSkills(): Skill[] {
  const out: Skill[] = [];
  for (const root of SKILL_ROOTS) {
    const dir = resolve(process.cwd(), root);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    entries.sort();
    for (const name of entries) {
      // The generic operate / postmortem / workflows skills document fragua's
      // own universal surface; audit those. The repo-specific skills
      // (frontend / design / backend) are bound to fragua's own code surface,
      // not the universal narrative, so they're out of scope.
      if (name !== "operate" && name !== "postmortem" && name !== "workflows") continue;
      const skillDir = resolve(dir, name);
      let isDir = false;
      try {
        isDir = statSync(skillDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const rel = `${root}/${name}/SKILL.md`;
      const snap = snapshotFile(rel);
      if (!snap.exists) continue;
      const fm = parseFrontMatter(readOrEmpty(rel));
      out.push({
        ...snap,
        name,
        description: fm.description ?? null,
        target_hint: SKILL_TARGET_HINTS[name] ?? null,
      });
    }
  }
  return out;
}

const focus = process.argv.slice(2).join(" ").trim();

const statusSrc = readOrEmpty("STATUS.md");
const readmeSrc = readOrEmpty("README.md");

const snapshot = {
  collected_at: new Date().toISOString(),
  cwd: process.cwd(),
  focus: focus || null,
  status: {
    file: existsSync(resolve(process.cwd(), "STATUS.md")) ? "STATUS.md" : null,
    delivers_today: extractMarkdownSection(statusSrc, "## What fragua delivers today"),
    does_not_deliver: extractMarkdownSection(statusSrc, "## What fragua does not deliver today"),
  },
  readme: {
    file: existsSync(resolve(process.cwd(), "README.md")) ? "README.md" : null,
    delivers_today: extractMarkdownSection(readmeSrc, "## What fragua delivers today"),
    does_not_deliver: extractMarkdownSection(readmeSrc, "## What fragua does not deliver today"),
  },
  proposals: collectProposals(),
  skills: collectSkills(),
};

process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
