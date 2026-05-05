// Assemble per-run system prompt extensions (context_files node attribute).
// Pulled into a separate module so it can be unit-tested without pi-agent-core.

import { createHash } from "node:crypto";
import type { ExecutionEnvironment, Skill } from "@swarm/workspace";
import { renderSkillsCatalog } from "@swarm/workspace";

/** Hard cap on the total bytes of project-conventions content prepended to the
 * system prompt. A single oversized AGENTS.md should not blow the context
 * window silently. Individual files are truncated; the final block never
 * exceeds this size. */
export const CONTEXT_FILES_MAX_BYTES = 32 * 1024;

/** Per-file record captured alongside the assembled system prompt. Durable on
 * `llm.start.context_files` so replay consumers can reason about whether a
 * file has changed between a run and its replay without needing the original
 * bytes. */
export interface ContextFileRecord {
  path: string;
  /** Hex sha256 of the file's raw contents (pre-truncation). */
  sha256: string;
  /** Byte length of the raw contents (pre-truncation). */
  bytes: number;
  /** True if this file's contribution to the final block was truncated to
   * fit under `CONTEXT_FILES_MAX_BYTES`. */
  truncated: boolean;
  /** "ok" when read succeeded; "missing" when `readFile` threw. Missing files
   * contribute no bytes but keep a record so the event log shows the full
   * set the workflow author asked for. */
  status: "ok" | "missing";
  /** Present only when `status === "missing"`. */
  error?: string;
}

export interface ContextBlock {
  /** The assembled `<project-conventions>` block, or "" if nothing was loaded. */
  text: string;
  /** Non-fatal issues (missing files, truncation). Callers forward these to
   * the event sink so replay/debug has a paper trail. */
  warnings: string[];
  /** Per-file records for durable capture on `llm.start.context_files`. In
   * the same order as the input `paths`. */
  files: ContextFileRecord[];
}

/** Auto-prepend `AGENTS.md` to a node's declared `context_files` list.
 * AGENTS.md is the project primer (repo layout, codebase map, ground
 * rules) and is applied to every codergen call so workflow authors
 * don't have to thread `context_files = "AGENTS.md"` through every
 * node. An explicit declaration already containing `AGENTS.md` is
 * preserved verbatim — no duplication, no order changes. */
export function applyDefaultContextFiles(declared: readonly string[]): string[] {
  return declared.includes("AGENTS.md") ? [...declared] : ["AGENTS.md", ...declared];
}

/** Read each path from the environment and wrap it in a single
 * `<project-conventions>` block. Missing files produce a warning and are
 * skipped. Truncates the final text to `CONTEXT_FILES_MAX_BYTES`. */
export async function loadContextFiles(
  env: Pick<ExecutionEnvironment, "readFile">,
  paths: readonly string[],
  max_bytes: number = CONTEXT_FILES_MAX_BYTES,
): Promise<ContextBlock> {
  if (paths.length === 0) return { text: "", warnings: [], files: [] };

  const warnings: string[] = [];
  const parts: string[] = [];
  const files: ContextFileRecord[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    try {
      const contents = await env.readFile(path);
      parts.push(`<project-conventions source="${escapeAttr(path)}">\n${contents}\n</project-conventions>`);
      files.push({
        path,
        sha256: sha256Hex(contents),
        bytes: Buffer.byteLength(contents, "utf8"),
        truncated: false,
        status: "ok",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`context_files: could not read "${path}" — ${msg}`);
      files.push({ path, sha256: "", bytes: 0, truncated: false, status: "missing", error: msg });
    }
  }
  if (parts.length === 0) return { text: "", warnings, files };

  let text = parts.join("\n\n");
  if (text.length > max_bytes) {
    const truncatedLen = text.length - max_bytes;
    text = `${text.slice(0, max_bytes)}\n\n[context_files: truncated ${truncatedLen} bytes to stay under ${max_bytes}]`;
    warnings.push(`context_files: truncated ${truncatedLen} bytes (cap ${max_bytes})`);
    // Flag every successfully-loaded file as truncated. Individual provenance
    // (which file was clipped) is recoverable from the ordered sha256s and
    // byte counts; the flag is a cheap signal for UIs.
    for (const f of files) if (f.status === "ok") f.truncated = true;
  }
  return { text, warnings, files };
}

/** Merge a base system prompt with an optional extension block. Extension
 * goes first so repo-level conventions frame whatever the base prompt says. */
export function mergeSystemPrompt(base: string, extension: string): string {
  if (!extension) return base;
  if (!base) return extension;
  return `${extension}\n\n${base}`;
}

/** Per-run environment facts surfaced to every node's system prompt so
 * agents know their isolation context — cwd and whether the project's
 * bootstrap command ran. `undefined` omits the block entirely (e.g.
 * single-process runs that don't use a worktree). */
export interface RunEnvironment {
  /** Absolute path the agent is working inside. Surfaced to the model
   * as `cwd:` (model-agnostic; works whether or not the path is a git
   * worktree). */
  worktreePath: string;
  /** Opaque session id, stable across the whole run. Used for
   * event-log correlation; not surfaced to the agent. */
  runId: string;
  /** The bootstrap command that ran (string form only). Omitted when the
   * project didn't configure one. Presence of this field signals "deps
   * are installed". */
  bootstrapCommand?: string | undefined;
}

export interface BuildSystemPromptInput {
  /** Global system prompt configured on the backend (e.g. a project-wide
   * "you are the coding agent" preamble). Becomes the fallback when no
   * node-level override is set. */
  global: string;
  /** Optional per-node override from `node.attrs.system_prompt`. When set,
   * this replaces `global` — a reviewer subagent or a planner node can
   * therefore swap the whole persona without hacking `context_files`. */
  perNode: string | undefined;
  /** Context-files block returned by `loadContextFiles`. Prepended so
   * repo conventions frame whatever the base prompt says. */
  contextBlock: string;
  /** Tier-1 skills catalog block (empty when no visible skills). Prepended
   * before `contextBlock` so skill advertisements frame the whole call —
   * order: skills → project-conventions → base. */
  skillsCatalog?: string;
  /** Per-run isolation facts (cwd, bootstrap status). Rendered as an
   * `<environment>` block at the top so agents know where they are
   * before reading anything else. */
  runEnv?: RunEnvironment | undefined;
}

/** The `<protocol>` block — the universal contract every codergen call
 * sees. Today it teaches a single emit marker, `<abort>reason</abort>`.
 * The text is a constant so it composes into the cache key without
 * variation per node, per run, or per provider. Workflow authors do not
 * restate this contract in node prompts. */
const PROTOCOL_BLOCK = [
  "<protocol>",
  "If you cannot proceed (missing target, contradictory constraints, external blocker),",
  "end your final message with `<abort>reason</abort>` as the entire last non-empty line —",
  "no prose before `<abort>` on the line, nothing after `</abort>` on the message. The",
  "reason is one short sentence; it is surfaced as the run's failure reason.",
  "Otherwise just produce your output.",
  "</protocol>",
].join("\n");

/** Returned for parity with `renderRunEnvironment` — pure string, no
 * dependencies, suitable for assertion in tests. */
export function renderProtocol(): string {
  return PROTOCOL_BLOCK;
}

/** Assemble the final system prompt for a single agent call. Isolated from
 * the backend so tests can round-trip the combinator without standing up
 * pi-agent-core, and so the fidelity/cache layer in `./fidelity.ts` can
 * compose it without duplicating the merge rules. */
export function buildSystemPrompt({
  global,
  perNode,
  contextBlock,
  skillsCatalog,
  runEnv,
}: BuildSystemPromptInput): string {
  const base = perNode !== undefined && perNode.length > 0 ? perNode : global;
  const catalog = skillsCatalog ?? "";
  // Prepend order (top → bottom of the assembled prompt):
  //   <environment>   — where the agent is running
  //   <protocol>      — the abort emit contract; constant per call
  //   skills catalog  — what tools are available
  //   project conv.   — AGENTS.md and friends
  //   base persona    — the per-node or global system prompt
  let out = base;
  out = mergeSystemPrompt(out, contextBlock);
  out = mergeSystemPrompt(out, catalog);
  out = mergeSystemPrompt(out, PROTOCOL_BLOCK);
  if (runEnv !== undefined) {
    out = mergeSystemPrompt(out, renderRunEnvironment(runEnv));
  }
  return out;
}

/** Render the `<environment>` block. Kept pure + tiny so it can be
 * unit-tested independently.
 *
 * The ❌ examples interpolate the actual cwd: by reflecting the value
 * the model is tempted to echo back, the negative example breaks the
 * cargo-culted `cd <cwd> && cmd` habit on the very token that anchors
 * it. Positive instruction comes first; the ❌ is illustration, not a
 * standalone rule. */
export function renderRunEnvironment(env: RunEnvironment): string {
  const cwd = env.worktreePath;
  const lines: string[] = [
    "<environment>",
    `cwd: ${cwd}`,
    "- Bash starts in cwd; run commands directly.",
    "  ✅ pwd",
    `  ❌ cd ${cwd} && pwd`,
    "- File tools resolve paths relative to cwd.",
    "  ✅ README.md",
    `  ❌ ${cwd}/README.md`,
  ];
  if (env.bootstrapCommand) {
    lines.push(`- \`${env.bootstrapCommand}\` ran here. If you edit dep manifests, re-run before tests.`);
  }
  lines.push("</environment>");
  return lines.join("\n");
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

function sha256Hex(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

/** Spec subset `materialiseForChild` consumes. The full `SubagentSpec`
 *  in @swarm/workspace carries a few runtime-only fields (signal,
 *  allowed_tools, etc.) we don't need here — the prompt builder
 *  cares only about persona override + skill name filter. Kept local
 *  so this module doesn't pull the workspace types graph. */
export interface MaterialiseChildSpec {
  system_prompt?: string;
  skills?: readonly string[];
}

export interface MaterialiseChildResult {
  /** Final system prompt fed into the child Agent. */
  systemPrompt: string;
  /** The skill subset projected into the child's catalog. Empty when
   *  the spec didn't name any — sub-agents do not inherit the parent's
   *  loaded skills implicitly. */
  effectiveSkills: Skill[];
}

/** Build the system prompt + skill catalog for a sub-agent run.
 *
 *  - `spec.system_prompt` overrides the parent's persona; otherwise the
 *    child inherits the parent's system prompt verbatim (the parent
 *    string already includes the protocol + environment blocks).
 *  - `spec.skills` is intersected with the parent's loaded catalog
 *    (unknown names silently dropped, by design — the LLM gets a
 *    smaller catalog rather than a hard error).
 *  - The caller owns the sub-agent's persona. When `spec.system_prompt`
 *    is set, that string drives the prompt verbatim. When absent, the
 *    sub-agent gets no persona by default — framework injection (the
 *    `<protocol>` block, env-info, the global codergen persona) would
 *    surprise the calling LLM, which constructed the tool call
 *    expecting a specific context shape.
 *  - `spec.skills` is intersected with the parent's loaded catalog
 *    (unknown names silently dropped). When the filtered set is
 *    non-empty, an `<available_skills>` block IS rendered into the
 *    sub-agent's prompt — the sub-agent has to know what skills exist
 *    in order to invoke them. With both `system_prompt` + skills set,
 *    the catalog block sits below the persona.
 *  - When `spec.system_prompt` is absent AND no skills, the sub-agent
 *    runs with NO system prompt at all.
 */
export function materialiseForChild(
  spec: MaterialiseChildSpec,
  _parentSystemPrompt: string,
  parentSkills: readonly Skill[],
): MaterialiseChildResult {
  const requested = spec.skills;
  const effectiveSkills: Skill[] =
    requested == null
      ? []
      : (() => {
          const allow = new Set(requested);
          return parentSkills.filter((s) => allow.has(s.name) && !s.disabled_reason);
        })();

  const persona = spec.system_prompt ?? "";
  const catalog = effectiveSkills.length > 0 ? renderSkillsCatalog(effectiveSkills) : "";
  const systemPrompt = catalog.length > 0 ? mergeSystemPrompt(persona, catalog) : persona;
  return { systemPrompt, effectiveSkills };
}
