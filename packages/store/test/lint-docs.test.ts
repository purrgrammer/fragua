// Doc-vs-code drift lint — see docs/proposals/drift-lint.md.
//
// Reads contract source files (schema.sql, swarm-events.ts, handler/types.ts)
// and asserts every structural token (table, column, enum literal,
// HandlerResult kind / halt reason) appears verbatim in the corresponding
// doc section. A line carrying `// drift-lint: ignore` (or `-- drift-lint:
// ignore` in SQL) directly above a declaration exempts the next column or
// union member.
//
// Live tests against the actual repo docs may currently fail — known drift
// is being resolved in parallel batches. The fixture-driven self-tests at
// the bottom prove the lint actually catches drift.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ───────────────────────── paths ─────────────────────────

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCHEMA_SQL = join(REPO_ROOT, "packages", "store", "src", "schema.sql");
const SWARM_EVENTS_TS = join(REPO_ROOT, "packages", "types", "src", "swarm-events.ts");
const HANDLER_TYPES_TS = join(REPO_ROOT, "packages", "core", "src", "handler", "types.ts");
const ARCH_MD = join(REPO_ROOT, "docs", "ARCHITECTURE.md");
const HANDLER_CONTRACT_MD = join(REPO_ROOT, "docs", "handler-contract.md");
const PROPOSALS_DIR = join(REPO_ROOT, "docs", "proposals");
const FIXTURES_DIR = join(__dirname, "fixtures", "drift-lint");

// ───────────────────────── types ─────────────────────────

export interface Finding {
  token: string;
  doc: string;
  section: string;
  source: string;
}

function formatFindings(findings: Finding[]): string {
  return findings
    .map((f) => `  drift-lint: token "${f.token}" missing from ${f.doc} (${f.section}); source: ${f.source}`)
    .join("\n");
}

// ───────────────────── doc slicing helpers ───────────────────

/**
 * Slice a markdown doc between the heading whose text matches `startRe`
 * (anchored on `## ` or `### `) and the next heading at the same or higher
 * level. Returns `null` if `startRe` not found.
 */
function sliceSection(md: string, startRe: RegExp, level: 2 | 3 = 2): string | null {
  const lines = md.split("\n");
  const startMarker = level === 2 ? /^## / : /^### /;
  const endMarkerSameOrHigher = level === 2 ? /^## / : /^##? /;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (startMarker.test(line) && startRe.test(line)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (endMarkerSameOrHigher.test(line)) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

// ───────────────────── SQL extraction ─────────────────────

interface Column {
  name: string;
  ignored: boolean;
}
interface Table {
  name: string;
  columns: Column[];
}

const SQL_KEYWORDS_NOT_COLUMNS = new Set(["PRIMARY", "FOREIGN", "CHECK", "UNIQUE", "CONSTRAINT"]);

/**
 * Extract `(name, columns[])` from CREATE TABLE blocks. SQL comments
 * (`-- …`) are stripped per-line, but a line whose trimmed body is exactly
 * `-- drift-lint: ignore` arms the next column to be flagged ignored.
 */
export function extractTables(sql: string): Table[] {
  const rawLines = sql.split("\n");
  // Build a parallel array of "ignore-next" flags by walking raw lines.
  const ignoreNextOnLine: boolean[] = new Array(rawLines.length).fill(false);
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = (rawLines[i] ?? "").trim();
    if (trimmed === "-- drift-lint: ignore") {
      // The next non-blank, non-comment line is the armed declaration.
      for (let j = i + 1; j < rawLines.length; j++) {
        const t = (rawLines[j] ?? "").trim();
        if (t === "" || t.startsWith("--")) continue;
        ignoreNextOnLine[j] = true;
        break;
      }
    }
  }

  const tables: Table[] = [];
  // Walk line-by-line so we can map back to original line numbers when
  // capturing column declarations (needed for the ignore annotation).
  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i] ?? "";
    const stripped = line.replace(/--.*$/, "").trim();
    const m = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/i.exec(stripped);
    if (!m) {
      i++;
      continue;
    }
    const tableName = m[1] ?? "";
    // Walk forward collecting body lines until we hit the closing `);`
    // (allowing trailing `STRICT` etc on the same line).
    const bodyLines: { text: string; lineIdx: number }[] = [];
    // Account for any body text on the opening line after `(`:
    const tail = stripped.slice(m[0].length);
    if (tail.length > 0) bodyLines.push({ text: tail, lineIdx: i });
    let depth = 1;
    let j = i + 1;
    for (; j < rawLines.length; j++) {
      const ln = rawLines[j] ?? "";
      const noComment = ln.replace(/--.*$/, "");
      // Track paren depth across the line.
      for (const ch of noComment) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth <= 0) {
        // strip the trailing `)` and whatever follows
        const idxClose = noComment.lastIndexOf(")");
        const before = idxClose >= 0 ? noComment.slice(0, idxClose) : noComment;
        if (before.trim().length > 0) bodyLines.push({ text: before, lineIdx: j });
        break;
      }
      if (noComment.trim().length > 0) bodyLines.push({ text: noComment, lineIdx: j });
    }

    // Now split the body into per-column fragments at top-level commas.
    // Each fragment carries the source line index of its first non-blank
    // character (for ignore-annotation lookup).
    interface Fragment {
      text: string;
      lineIdx: number;
    }
    const fragments: Fragment[] = [];
    let buf = "";
    let bufStartLine = -1;
    let pdepth = 0;
    const pushBuf = () => {
      if (buf.trim().length > 0) {
        fragments.push({ text: buf.trim(), lineIdx: bufStartLine });
      }
      buf = "";
      bufStartLine = -1;
    };
    for (const bl of bodyLines) {
      for (let k = 0; k < bl.text.length; k++) {
        const ch = bl.text[k] ?? "";
        if (ch === "(") pdepth++;
        else if (ch === ")") pdepth--;
        if (ch === "," && pdepth === 0) {
          pushBuf();
          continue;
        }
        if (buf.length === 0 && ch.trim() === "") continue; // skip leading WS
        if (buf.length === 0) bufStartLine = bl.lineIdx;
        buf += ch;
      }
      // newline between body lines doesn't split columns, but keep a space
      if (buf.length > 0) buf += " ";
    }
    pushBuf();

    const columns: Column[] = [];
    for (const frag of fragments) {
      const firstWord = frag.text.split(/\s+/)[0]?.toUpperCase() ?? "";
      if (SQL_KEYWORDS_NOT_COLUMNS.has(firstWord)) continue;
      const nameMatch = /^(\w+)\b/.exec(frag.text);
      if (!nameMatch) continue;
      const name = nameMatch[1] ?? "";
      const ignored = frag.lineIdx >= 0 ? ignoreNextOnLine[frag.lineIdx] === true : false;
      columns.push({ name, ignored });
    }
    tables.push({ name: tableName, columns });
    i = j + 1;
  }
  return tables;
}

export function auditSchemaVsArch(opts: { schemaPath: string; archPath: string }): Finding[] {
  const sql = readFileSync(opts.schemaPath, "utf8");
  const md = readFileSync(opts.archPath, "utf8");
  const section = sliceSection(md, /^## 2\. /, 2);
  const haystack = section ?? md;
  const sectionLabel = section ? "## 2. Schema" : "(file)";
  const tables = extractTables(sql);
  const findings: Finding[] = [];
  for (const t of tables) {
    if (!haystack.includes(t.name)) {
      findings.push({
        token: t.name,
        doc: opts.archPath,
        section: sectionLabel,
        source: `CREATE TABLE ${t.name}`,
      });
    }
    for (const c of t.columns) {
      if (c.ignored) continue;
      if (!haystack.includes(c.name)) {
        findings.push({
          token: c.name,
          doc: opts.archPath,
          section: sectionLabel,
          source: `${t.name}.${c.name}`,
        });
      }
    }
  }
  return findings;
}

// ───────────────────── TS literal extraction ─────────────────

/**
 * Pull every `"..."` string literal from a slice of TS source, honouring
 * `// drift-lint: ignore` markers that sit on the immediately-preceding
 * non-blank source line. Returns `{ value, ignored }` per literal.
 */
export function extractStringLiterals(src: string): { value: string; ignored: boolean }[] {
  const lines = src.split("\n");
  const ignoreNext: boolean[] = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "// drift-lint: ignore") {
      for (let j = i + 1; j < lines.length; j++) {
        const t = (lines[j] ?? "").trim();
        if (t === "" || t.startsWith("//")) continue;
        ignoreNext[j] = true;
        break;
      }
    }
  }
  const out: { value: string; ignored: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Strip inline `// …` comments to avoid picking up doc-comment quotes.
    // (block /* */ comments aren't used for inline literals here.)
    const code = line.replace(/\/\/.*$/, "");
    const re = /"([^"\\\n]*(?:\\.[^"\\\n]*)*)"/g;
    for (const m of code.matchAll(re)) {
      out.push({ value: m[1] ?? "", ignored: ignoreNext[i] === true });
    }
  }
  return out;
}

/** Slice the body of a top-level `export type Foo = …;` declaration. */
function sliceTypeDecl(src: string, name: string): string | null {
  const re = new RegExp(`export\\s+type\\s+${name}\\s*=([\\s\\S]*?);\\s*\\n`);
  const m = re.exec(src);
  return m ? (m[1] ?? null) : null;
}

interface EventTaxonomyOpts {
  swarmEventsPath: string;
  archPath: string;
}

export function auditEventTaxonomy(opts: EventTaxonomyOpts): Finding[] {
  const ts = readFileSync(opts.swarmEventsPath, "utf8");
  const md = readFileSync(opts.archPath, "utf8");
  const section3 = sliceSection(md, /^## 3\. /, 2);
  if (!section3) {
    return [
      {
        token: "## 3. Event taxonomy",
        doc: opts.archPath,
        section: "(missing)",
        source: "ARCHITECTURE.md",
      },
    ];
  }
  const findings: Finding[] = [];

  // RunStatus / HaltReason / QuarantineReason — straight unions of literals.
  for (const name of ["RunStatus", "HaltReason", "QuarantineReason"]) {
    const decl = sliceTypeDecl(ts, name);
    if (decl == null) {
      findings.push({
        token: name,
        doc: opts.swarmEventsPath,
        section: "(declaration not found)",
        source: `extractor: ${name}`,
      });
      continue;
    }
    for (const lit of extractStringLiterals(decl)) {
      if (lit.ignored) continue;
      if (!section3.includes(lit.value)) {
        findings.push({
          token: lit.value,
          doc: opts.archPath,
          section: "## 3. Event taxonomy",
          source: `${name} literal`,
        });
      }
    }
  }

  // IntentEvent / FactEvent — capture only the `type: "..."` discriminators
  // (payload field names like "selected", "reason", "fresh", "cancel" are
  // documented in prose / table cells and shouldn't be enforced as bare tokens
  // because they collide with English words; the discriminator strings are
  // the load-bearing structural tokens).
  for (const unionName of ["IntentEvent", "FactEvent"]) {
    const decl = sliceTypeDecl(ts, unionName);
    if (decl == null) {
      findings.push({
        token: unionName,
        doc: opts.swarmEventsPath,
        section: "(declaration not found)",
        source: `extractor: ${unionName}`,
      });
      continue;
    }
    // Walk lines; capture discriminators while honouring ignore markers.
    const lines = decl.split("\n");
    const ignoreNext: boolean[] = new Array(lines.length).fill(false);
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() === "// drift-lint: ignore") {
        for (let j = i + 1; j < lines.length; j++) {
          const t = (lines[j] ?? "").trim();
          if (t === "" || t.startsWith("//")) continue;
          ignoreNext[j] = true;
          break;
        }
      }
    }
    const discrimRe = /\btype:\s*"([^"]+)"/;
    for (let i = 0; i < lines.length; i++) {
      const m = discrimRe.exec(lines[i] ?? "");
      if (!m) continue;
      if (ignoreNext[i]) continue;
      const value = m[1] ?? "";
      if (!section3.includes(value)) {
        findings.push({
          token: value,
          doc: opts.archPath,
          section: "## 3. Event taxonomy",
          source: `${unionName} discriminator`,
        });
      }
    }
  }

  // DaemonEvent discriminators must appear in the §3 "Daemon events"
  // subsection specifically.
  const daemonSection = sliceSection(section3, /^### Daemon events/, 3);
  const daemonHaystack = daemonSection ?? section3;
  const daemonSectionLabel = daemonSection
    ? "## 3 → ### Daemon events"
    : "## 3. Event taxonomy (Daemon events subsection missing)";
  const daemonDecl = sliceTypeDecl(ts, "DaemonEvent");
  if (daemonDecl == null) {
    findings.push({
      token: "DaemonEvent",
      doc: opts.swarmEventsPath,
      section: "(declaration not found)",
      source: "extractor: DaemonEvent",
    });
  } else {
    const lines = daemonDecl.split("\n");
    const ignoreNext: boolean[] = new Array(lines.length).fill(false);
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() === "// drift-lint: ignore") {
        for (let j = i + 1; j < lines.length; j++) {
          const t = (lines[j] ?? "").trim();
          if (t === "" || t.startsWith("//")) continue;
          ignoreNext[j] = true;
          break;
        }
      }
    }
    const discrimRe = /\btype:\s*"(daemon\.[^"]+)"/;
    for (let i = 0; i < lines.length; i++) {
      const m = discrimRe.exec(lines[i] ?? "");
      if (!m) continue;
      if (ignoreNext[i]) continue;
      const value = m[1] ?? "";
      if (!daemonHaystack.includes(value)) {
        findings.push({
          token: value,
          doc: opts.archPath,
          section: daemonSectionLabel,
          source: "DaemonEvent discriminator",
        });
      }
    }
  }

  return findings;
}

// ───────────────────── HandlerResult lint ─────────────────

export function auditHandlerContract(opts: { handlerTypesPath: string; contractMdPath: string }): Finding[] {
  const ts = readFileSync(opts.handlerTypesPath, "utf8");
  const md = readFileSync(opts.contractMdPath, "utf8");
  const findings: Finding[] = [];

  // HandlerResult declaration
  const decl = sliceTypeDecl(ts, "HandlerResult");
  if (decl == null) {
    findings.push({
      token: "HandlerResult",
      doc: opts.handlerTypesPath,
      section: "(declaration not found)",
      source: "extractor",
    });
    return findings;
  }

  // kind discriminators
  const kindRe = /\bkind:\s*"([^"]+)"/g;
  const kinds = new Set<string>();
  for (const m of decl.matchAll(kindRe)) kinds.add(m[1] ?? "");
  for (const k of kinds) {
    if (!md.includes(`"${k}"`)) {
      findings.push({
        token: `"${k}"`,
        doc: opts.contractMdPath,
        section: "(file)",
        source: `HandlerResult kind`,
      });
    }
  }

  // halt reasons — pull literals from the line(s) following the
  // `kind: "halt"` arm up to the next `}`.
  const haltIdx = decl.search(/\bkind:\s*"halt"/);
  if (haltIdx >= 0) {
    const tail = decl.slice(haltIdx);
    const closeIdx = tail.indexOf("}");
    const arm = closeIdx >= 0 ? tail.slice(0, closeIdx) : tail;
    const reasonMatch = /reason:\s*([^;]+?)(?:;|\n\s*detail)/.exec(arm);
    if (reasonMatch) {
      const reasonExpr = reasonMatch[1] ?? "";
      const litRe = /"([^"]+)"/g;
      for (const m of reasonExpr.matchAll(litRe)) {
        const reason = m[1] ?? "";
        if (!md.includes(`"${reason}"`)) {
          findings.push({
            token: `"${reason}"`,
            doc: opts.contractMdPath,
            section: "(file)",
            source: `HandlerResult halt reason`,
          });
        }
      }
    }
  }

  return findings;
}

// ───────────────────── proposal-index lint ───────────────

const SECTION_TO_STATUS: Record<string, string> = {
  Shipped: "shipped",
  "In progress": "in-progress",
  Accepted: "accepted",
  // The README header is "Proposed (under design)" — match by leading token.
  Proposed: "proposed",
  Deferred: "deferred",
  Discarded: "discarded",
};

function parseFrontMatterField(md: string, field: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return null;
  const block = m[1] ?? "";
  for (const line of block.split("\n")) {
    const km = /^(\w+):\s*(.+?)\s*$/.exec(line);
    if (!km) continue;
    if (km[1] === field) {
      let value = km[2] ?? "";
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }
  return null;
}

export function parseFrontMatterStatus(md: string): string | null {
  return parseFrontMatterField(md, "status");
}

export function parseFrontMatterSummary(md: string): string | null {
  return parseFrontMatterField(md, "summary");
}

export function parseFrontMatterTitle(md: string): string | null {
  return parseFrontMatterField(md, "title");
}

interface IndexEntry {
  file: string; // basename, e.g. "drift-lint.md"
  section: string; // README heading text
}

function parseIndexEntries(md: string): IndexEntry[] {
  const lines = md.split("\n");
  const out: IndexEntry[] = [];
  let currentSection = "";
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      currentSection = h[1] ?? "";
      continue;
    }
    // table row links: `[Title](./file.md)` — capture relative file name.
    const linkRe = /\[[^\]]+\]\(\.\/([\w.-]+\.md)\)/g;
    for (const m of line.matchAll(linkRe)) {
      out.push({ file: m[1] ?? "", section: currentSection });
    }
  }
  return out;
}

export function auditProposalIndex(opts: { proposalsDir: string }): Finding[] {
  const findings: Finding[] = [];
  const indexPath = join(opts.proposalsDir, "README.md");
  const indexMd = readFileSync(indexPath, "utf8");
  const indexEntries = parseIndexEntries(indexMd);
  const indexedFiles = new Map<string, IndexEntry>();
  for (const e of indexEntries) indexedFiles.set(e.file, e);

  const onDisk = readdirSync(opts.proposalsDir).filter((f) => f.endsWith(".md") && f !== "README.md");

  // Every on-disk proposal file appears in the index.
  for (const f of onDisk) {
    if (!indexedFiles.has(f)) {
      findings.push({
        token: f,
        doc: indexPath,
        section: "(any)",
        source: `${f} on disk but not linked in README index`,
      });
    }
  }

  // Each indexed entry's section matches the file's front-matter status.
  for (const f of onDisk) {
    const entry = indexedFiles.get(f);
    if (!entry) continue;
    const status = parseFrontMatterStatus(readFileSync(join(opts.proposalsDir, f), "utf8"));
    if (status == null) {
      findings.push({
        token: "front-matter status",
        doc: join(opts.proposalsDir, f),
        section: "(YAML front-matter)",
        source: f,
      });
      continue;
    }
    // Map README section → expected status string.
    let expected: string | null = null;
    for (const [sectionPrefix, statusValue] of Object.entries(SECTION_TO_STATUS)) {
      if (entry.section.startsWith(sectionPrefix)) {
        expected = statusValue;
        break;
      }
    }
    if (expected == null) {
      findings.push({
        token: entry.section,
        doc: indexPath,
        section: "(unknown section header)",
        source: `${f} listed under "${entry.section}"`,
      });
      continue;
    }
    if (status !== expected) {
      findings.push({
        token: status,
        doc: indexPath,
        section: entry.section,
        source: `${f} front-matter status="${status}" but indexed under "${entry.section}" (expected status="${expected}")`,
      });
    }
  }

  return findings;
}

// ────────────────── capability-claim lint ─────────────────

// For every status: shipped proposal, the README "What swarm delivers today"
// section must contain a substring match for the proposal's front-matter
// `summary` (preferred) or `title`. Suppression is a `// drift-lint: ignore
// <basename>.md` line anywhere in the section — placed adjacent to a bullet
// for human readers; the audit matches by basename for robustness against
// reformatting.

export function auditCapabilityClaims(opts: {
  proposalsDir: string;
  readmePath: string;
  readmeSection: string;
}): Finding[] {
  const findings: Finding[] = [];
  const readmeMd = readFileSync(opts.readmePath, "utf8");
  const escaped = opts.readmeSection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const section = sliceSection(readmeMd, new RegExp(`^## ${escaped}\\b`), 2);
  if (section == null) {
    findings.push({
      token: opts.readmeSection,
      doc: opts.readmePath,
      section: "(missing)",
      source: "auditCapabilityClaims",
    });
    return findings;
  }

  const suppressed = new Set<string>();
  const ignoreRe = /^\s*\/\/\s*drift-lint:\s*ignore\s+(\S+\.md)\s*$/;
  for (const line of section.split("\n")) {
    const m = ignoreRe.exec(line);
    if (m) suppressed.add(m[1] ?? "");
  }

  const onDisk = readdirSync(opts.proposalsDir).filter((f) => f.endsWith(".md") && f !== "README.md");
  for (const f of onDisk) {
    const proposalPath = join(opts.proposalsDir, f);
    const md = readFileSync(proposalPath, "utf8");
    if (parseFrontMatterStatus(md) !== "shipped") continue;
    if (suppressed.has(f)) continue;
    const summary = parseFrontMatterSummary(md);
    const title = parseFrontMatterTitle(md);
    const phrase = summary ?? title;
    if (phrase == null || phrase.length === 0) {
      findings.push({
        token: "front-matter summary or title",
        doc: proposalPath,
        section: "(YAML front-matter)",
        source: f,
      });
      continue;
    }
    if (!section.includes(phrase)) {
      findings.push({
        token: phrase,
        doc: opts.readmePath,
        section: `## ${opts.readmeSection}`,
        source: f,
      });
    }
  }
  return findings;
}

// ───────────────────────── tests ─────────────────────────

describe("drift-lint — live repo", () => {
  test("schema.sql tables and columns appear in ARCHITECTURE.md §2", () => {
    const findings = auditSchemaVsArch({ schemaPath: SCHEMA_SQL, archPath: ARCH_MD });
    if (findings.length > 0) {
      throw new Error(`drift-lint findings (schema vs §2):\n${formatFindings(findings)}`);
    }
    expect(findings).toEqual([]);
  });

  test("RunStatus / IntentEvent / FactEvent / HaltReason / QuarantineReason literals appear in ARCHITECTURE.md §3", () => {
    // Restricted to the non-DaemonEvent subset so the §3-wide check stays
    // crisp; DaemonEvent is checked separately against its subsection.
    const findings = auditEventTaxonomy({
      swarmEventsPath: SWARM_EVENTS_TS,
      archPath: ARCH_MD,
    }).filter((f) => f.source !== "DaemonEvent discriminator");
    if (findings.length > 0) {
      throw new Error(`drift-lint findings (event taxonomy):\n${formatFindings(findings)}`);
    }
    expect(findings).toEqual([]);
  });

  test("DaemonEvent types appear in ARCHITECTURE.md §3 'Daemon events' subsection", () => {
    const findings = auditEventTaxonomy({
      swarmEventsPath: SWARM_EVENTS_TS,
      archPath: ARCH_MD,
    }).filter((f) => f.source === "DaemonEvent discriminator");
    if (findings.length > 0) {
      throw new Error(`drift-lint findings (daemon events):\n${formatFindings(findings)}`);
    }
    expect(findings).toEqual([]);
  });

  test("HandlerResult kinds and halt reasons appear in handler-contract.md", () => {
    const findings = auditHandlerContract({
      handlerTypesPath: HANDLER_TYPES_TS,
      contractMdPath: HANDLER_CONTRACT_MD,
    });
    if (findings.length > 0) {
      throw new Error(`drift-lint findings (handler contract):\n${formatFindings(findings)}`);
    }
    expect(findings).toEqual([]);
  });

  test("docs/proposals/README.md indexes every proposal file", () => {
    const findings = auditProposalIndex({ proposalsDir: PROPOSALS_DIR }).filter((f) =>
      f.source.includes("on disk but not linked"),
    );
    if (findings.length > 0) {
      throw new Error(`drift-lint findings (proposal index):\n${formatFindings(findings)}`);
    }
    expect(findings).toEqual([]);
  });

  test("docs/proposals/README.md status sections match each file's front-matter status", () => {
    const findings = auditProposalIndex({ proposalsDir: PROPOSALS_DIR }).filter(
      (f) => !f.source.includes("on disk but not linked"),
    );
    if (findings.length > 0) {
      throw new Error(`drift-lint findings (proposal status):\n${formatFindings(findings)}`);
    }
    expect(findings).toEqual([]);
  });

  test("every shipped proposal has a matching capability claim in README", () => {
    const findings = auditCapabilityClaims({
      proposalsDir: PROPOSALS_DIR,
      readmePath: join(REPO_ROOT, "README.md"),
      readmeSection: "What swarm delivers today",
    });
    if (findings.length > 0) {
      throw new Error(`drift-lint findings (capability claims):\n${formatFindings(findings)}`);
    }
    expect(findings).toEqual([]);
  });
});

describe("drift-lint — capability-claim audit", () => {
  const TMP_DIR = join(FIXTURES_DIR, "_tmp-cap-proposals");
  const TMP_README = join(FIXTURES_DIR, "_tmp-cap-readme.md");

  function setup(opts: { readmeBody: string }): { proposalBasename: string } {
    rmSync(TMP_DIR, { recursive: true, force: true });
    mkdirSync(TMP_DIR, { recursive: true });
    const basename = "phantom-feature.md";
    const frontMatter = [
      "---",
      'title: "Phantom feature"',
      'summary: "absent-capability-xyzzy"',
      "status: shipped",
      "maturity: specified",
      "---",
      "",
      "# Phantom feature",
      "",
    ].join("\n");
    writeFileSync(join(TMP_DIR, basename), frontMatter);
    writeFileSync(TMP_README, opts.readmeBody);
    return { proposalBasename: basename };
  }

  function teardown(): void {
    rmSync(TMP_DIR, { recursive: true, force: true });
    rmSync(TMP_README, { force: true });
  }

  test("flags a shipped proposal whose summary is absent from the README section", () => {
    const readme = [
      "# fixture",
      "",
      "## What swarm delivers today",
      "",
      "- something else entirely",
      "",
      "## Next",
      "",
    ].join("\n");
    const { proposalBasename } = setup({ readmeBody: readme });
    try {
      const findings = auditCapabilityClaims({
        proposalsDir: TMP_DIR,
        readmePath: TMP_README,
        readmeSection: "What swarm delivers today",
      });
      expect(findings.length).toBe(1);
      const finding = findings[0];
      if (!finding) throw new Error("expected one finding");
      expect(finding.token).toBe("absent-capability-xyzzy");
      expect(finding.source).toBe(proposalBasename);
    } finally {
      teardown();
    }
  });

  test("// drift-lint: ignore exempts a flagged proposal", () => {
    const readme = [
      "# fixture",
      "",
      "## What swarm delivers today",
      "",
      "// drift-lint: ignore phantom-feature.md",
      "- something else entirely",
      "",
      "## Next",
      "",
    ].join("\n");
    setup({ readmeBody: readme });
    try {
      const findings = auditCapabilityClaims({
        proposalsDir: TMP_DIR,
        readmePath: TMP_README,
        readmeSection: "What swarm delivers today",
      });
      expect(findings).toEqual([]);
    } finally {
      teardown();
    }
  });
});

describe("drift-lint — self-test against fixtures", () => {
  const cases: Array<{ name: "drift" | "clean"; expectFindings: boolean }> = [
    { name: "drift", expectFindings: true },
    { name: "clean", expectFindings: false },
  ];

  for (const c of cases) {
    test(`fixture ${c.name} yields the expected verdict`, () => {
      const schemaPath = join(FIXTURES_DIR, c.name === "drift" ? "schema-with-drift.sql" : "schema-clean.sql");
      const archPath = join(FIXTURES_DIR, c.name === "drift" ? "arch-drift-fragment.md" : "arch-clean-fragment.md");
      const findings = auditSchemaVsArch({ schemaPath, archPath });
      if (c.expectFindings) {
        expect(findings.length).toBeGreaterThan(0);
        const tokens = findings.map((f) => f.token);
        expect(tokens).toContain("secret_internal_field");
        const msg = formatFindings(findings);
        expect(msg).toContain("secret_internal_field");
        expect(msg).toContain(archPath);
        expect(msg).toContain("## 2. Schema");
      } else {
        expect(findings).toEqual([]);
      }
    });
  }
});

describe("drift-lint — ignore annotation", () => {
  test("// drift-lint: ignore exempts the next column declaration", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS t (",
      "  id TEXT PRIMARY KEY,",
      "  -- drift-lint: ignore",
      "  xyz_internal INTEGER NOT NULL,",
      "  visible_col INTEGER NOT NULL",
      ") STRICT;",
    ].join("\n");
    const tables = extractTables(sql);
    expect(tables.length).toBe(1);
    const t = tables[0];
    if (!t) throw new Error("expected one table");
    const byName = new Map(t.columns.map((c) => [c.name, c.ignored]));
    expect(byName.get("id")).toBe(false);
    expect(byName.get("xyz_internal")).toBe(true);
    expect(byName.get("visible_col")).toBe(false);

    // End-to-end: doc names id + visible_col but NOT xyz_internal; lint
    // returns no findings because the ignored column is dropped from the
    // audit set.
    const tmpSchema = join(FIXTURES_DIR, "_tmp-ignore-schema.sql");
    const tmpArch = join(FIXTURES_DIR, "_tmp-ignore-arch.md");
    const md = "## 2. Schema\n\nThe table `t` carries `id` and `visible_col`.\n\n## 3. End\n";
    writeFileSync(tmpSchema, sql);
    writeFileSync(tmpArch, md);
    try {
      const findings = auditSchemaVsArch({ schemaPath: tmpSchema, archPath: tmpArch });
      expect(findings).toEqual([]);
    } finally {
      rmSync(tmpSchema, { force: true });
      rmSync(tmpArch, { force: true });
    }
  });

  test("// drift-lint: ignore exempts the next enum literal", () => {
    const tsSrc = [
      "export type Foo =",
      '  | "alpha"',
      "  // drift-lint: ignore",
      '  | "beta_internal"',
      '  | "gamma";',
      "",
    ].join("\n");
    // Slice the body the way auditEventTaxonomy does.
    const body = sliceTypeDecl(tsSrc, "Foo");
    expect(body).not.toBeNull();
    if (body == null) throw new Error("expected body");
    const literals = extractStringLiterals(body);
    const map = new Map(literals.map((l) => [l.value, l.ignored]));
    expect(map.get("alpha")).toBe(false);
    expect(map.get("beta_internal")).toBe(true);
    expect(map.get("gamma")).toBe(false);
  });
});
