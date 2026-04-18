// OpenAI v4a-style patch parser + applier.
//
// Envelope:
//   *** Begin Patch
//   *** Update File: <path>
//   @@ [optional anchor]
//    context line
//   -line to remove
//   +line to add
//   *** Add File: <path>
//   +line of new file
//   *** Delete File: <path>
//   *** End Patch
//
// Context lines use a single-space prefix. The parser also tolerates context
// lines written with no prefix (a common LLM quirk) as long as they are not
// confusable with a directive.
//
// Matching rule for Update hunks: the joined (context + removed) block must
// appear exactly once in the target file. An optional `@@ <anchor>` line
// scopes the search to the region after the first occurrence of <anchor>,
// which disambiguates hunks that would otherwise be ambiguous.

import type { ExecutionEnvironment } from "./types.ts";

export class ApplyPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyPatchError";
  }
}

type HunkLine = { kind: "context" | "remove" | "add"; text: string };

interface Hunk {
  anchor?: string;
  lines: HunkLine[];
}

interface UpdateOp {
  op: "update";
  path: string;
  hunks: Hunk[];
}
interface AddOp {
  op: "add";
  path: string;
  content: string;
}
interface DeleteOp {
  op: "delete";
  path: string;
}
type Op = UpdateOp | AddOp | DeleteOp;

export interface ApplyPatchResult {
  files_changed: Array<{
    path: string;
    op: "update" | "add" | "delete";
    bytes_before?: number;
    bytes_after?: number;
  }>;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

export function parsePatch(input: string): Op[] {
  const raw = input.replace(/\r\n/g, "\n");
  const lines = raw.split("\n");

  // Trim to envelope.
  const startIdx = lines.findIndex((l) => l.trim() === BEGIN);
  if (startIdx === -1) throw new ApplyPatchError(`missing "${BEGIN}" sentinel`);
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim() === END);
  if (endIdx === -1) throw new ApplyPatchError(`missing "${END}" sentinel`);

  const body = lines.slice(startIdx + 1, endIdx);
  const ops: Op[] = [];
  let i = 0;

  while (i < body.length) {
    const line = body[i] ?? "";
    if (line.trim() === "") {
      i++;
      continue;
    }
    const update = line.match(/^\*\*\* Update File: (.+)$/);
    const add = line.match(/^\*\*\* Add File: (.+)$/);
    const del = line.match(/^\*\*\* Delete File: (.+)$/);
    const move = line.match(/^\*\*\* Move File:/);

    if (move) {
      throw new ApplyPatchError("*** Move File is not supported yet");
    }

    if (update) {
      const path = update[1]!.trim();
      const { hunks, consumed } = parseHunks(body, i + 1);
      ops.push({ op: "update", path, hunks });
      i += 1 + consumed;
      continue;
    }

    if (add) {
      const path = add[1]!.trim();
      const { content, consumed } = parseAddBody(body, i + 1);
      ops.push({ op: "add", path, content });
      i += 1 + consumed;
      continue;
    }

    if (del) {
      const path = del[1]!.trim();
      ops.push({ op: "delete", path });
      i++;
      continue;
    }

    throw new ApplyPatchError(`unexpected line inside patch: ${JSON.stringify(line)}`);
  }

  if (ops.length === 0) throw new ApplyPatchError("patch contains no file operations");
  return ops;
}

function isDirectiveLine(line: string): boolean {
  return /^\*\*\* (Update|Add|Delete|Move) File:/.test(line) || line.trim() === END;
}

function parseHunks(body: string[], start: number): { hunks: Hunk[]; consumed: number } {
  const hunks: Hunk[] = [];
  let current: Hunk = { lines: [] };
  let i = start;

  while (i < body.length && !isDirectiveLine(body[i] ?? "")) {
    const line = body[i] ?? "";
    const anchorMatch = line.match(/^@@(?:\s+(.*))?$/);
    if (anchorMatch) {
      if (current.lines.length > 0 || current.anchor !== undefined) {
        hunks.push(current);
      }
      const anchorText = anchorMatch[1]?.trim();
      current = anchorText ? { anchor: anchorText, lines: [] } : { lines: [] };
      i++;
      continue;
    }

    if (line.startsWith("+")) {
      current.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.lines.push({ kind: "remove", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      current.lines.push({ kind: "context", text: line.slice(1) });
    } else if (line === "") {
      // A bare blank line inside a hunk is treated as a blank context line.
      current.lines.push({ kind: "context", text: "" });
    } else {
      // Tolerate context lines without the space prefix.
      current.lines.push({ kind: "context", text: line });
    }
    i++;
  }

  if (current.lines.length > 0 || current.anchor !== undefined) {
    hunks.push(current);
  }
  if (hunks.length === 0) {
    throw new ApplyPatchError("Update File directive has no hunk body");
  }
  return { hunks, consumed: i - start };
}

function parseAddBody(body: string[], start: number): { content: string; consumed: number } {
  const out: string[] = [];
  let i = start;
  while (i < body.length && !isDirectiveLine(body[i] ?? "")) {
    const line = body[i] ?? "";
    if (line.startsWith("+")) {
      out.push(line.slice(1));
    } else if (line.trim() === "") {
      // tolerate blank separators
    } else {
      throw new ApplyPatchError(`Add File body expects "+" lines, got: ${JSON.stringify(line)}`);
    }
    i++;
  }
  if (out.length === 0) throw new ApplyPatchError("Add File directive has no content lines");
  return { content: `${out.join("\n")}\n`, consumed: i - start };
}

/** Apply a parsed patch. Pre-validates every op against the current env state,
 * then writes. A validation failure leaves the filesystem untouched. */
export async function applyPatch(input: string, env: ExecutionEnvironment): Promise<ApplyPatchResult> {
  const ops = parsePatch(input);
  const plan: Array<
    | { op: "update"; path: string; before: string; after: string }
    | { op: "add"; path: string; content: string }
    | { op: "delete"; path: string; before: string }
  > = [];

  for (const op of ops) {
    if (op.op === "add") {
      if (await env.exists(op.path)) {
        throw new ApplyPatchError(`Add File: ${op.path} already exists`);
      }
      plan.push({ op: "add", path: op.path, content: op.content });
      continue;
    }
    if (op.op === "delete") {
      if (!(await env.exists(op.path))) {
        throw new ApplyPatchError(`Delete File: ${op.path} does not exist`);
      }
      const before = await env.readFile(op.path);
      plan.push({ op: "delete", path: op.path, before });
      continue;
    }
    // update
    if (!(await env.exists(op.path))) {
      throw new ApplyPatchError(`Update File: ${op.path} does not exist`);
    }
    const before = await env.readFile(op.path);
    let working = before;
    for (const hunk of op.hunks) {
      working = applyHunk(working, hunk, op.path);
    }
    plan.push({ op: "update", path: op.path, before, after: working });
  }

  // Execute — validation has already succeeded for every op.
  const result: ApplyPatchResult = { files_changed: [] };
  for (const p of plan) {
    if (p.op === "add") {
      await env.writeFile(p.path, p.content);
      result.files_changed.push({ path: p.path, op: "add", bytes_after: p.content.length });
    } else if (p.op === "delete") {
      // ExecutionEnvironment has no explicit delete; fall back to shell.
      const res = await env.exec(`rm -f -- ${shellQuote(p.path)}`);
      if (res.exitCode !== 0) {
        throw new ApplyPatchError(`failed to delete ${p.path}: ${res.stderr.trim()}`);
      }
      result.files_changed.push({ path: p.path, op: "delete", bytes_before: p.before.length });
    } else {
      await env.writeFile(p.path, p.after);
      result.files_changed.push({
        path: p.path,
        op: "update",
        bytes_before: p.before.length,
        bytes_after: p.after.length,
      });
    }
  }
  return result;
}

function applyHunk(source: string, hunk: Hunk, path: string): string {
  const oldBlock = hunk.lines
    .filter((l) => l.kind === "context" || l.kind === "remove")
    .map((l) => l.text)
    .join("\n");
  const newBlock = hunk.lines
    .filter((l) => l.kind === "context" || l.kind === "add")
    .map((l) => l.text)
    .join("\n");

  if (oldBlock === newBlock) {
    throw new ApplyPatchError(`Update File ${path}: hunk is a no-op`);
  }

  const searchIn = hunk.anchor ? narrowByAnchor(source, hunk.anchor, path) : { text: source, offset: 0 };
  const idx = searchIn.text.indexOf(oldBlock);
  if (idx === -1) {
    throw new ApplyPatchError(
      `Update File ${path}: hunk context not found${hunk.anchor ? ` under anchor "${hunk.anchor}"` : ""}`,
    );
  }
  // Without an anchor, require a unique match so silent wrong-location edits can't happen.
  // With an anchor, the anchor is the disambiguator — take the first match after it.
  if (!hunk.anchor && searchIn.text.indexOf(oldBlock, idx + 1) !== -1) {
    throw new ApplyPatchError(
      `Update File ${path}: hunk matches more than once — add an @@ anchor or more surrounding context`,
    );
  }
  const absoluteIdx = searchIn.offset + idx;
  return source.slice(0, absoluteIdx) + newBlock + source.slice(absoluteIdx + oldBlock.length);
}

function narrowByAnchor(source: string, anchor: string, path: string): { text: string; offset: number } {
  const idx = source.indexOf(anchor);
  if (idx === -1) {
    throw new ApplyPatchError(`Update File ${path}: anchor "${anchor}" not found`);
  }
  return { text: source.slice(idx), offset: idx };
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
