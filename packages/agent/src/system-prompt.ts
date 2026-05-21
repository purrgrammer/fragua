// Assemble per-run system prompt extensions (context_files node attribute).
// Pulled into a separate module so it can be unit-tested without pi-agent-core.

import { createHash } from "node:crypto";
import type { ExecutionEnvironment, Skill } from "@fragua/workspace";
import { renderSkillsCatalog } from "@fragua/workspace";

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
 * rules) and is applied to every llm call so workflow authors
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
  /** Absolute path the agent is working inside — the resolved
   * `ExecutionEnvironment.cwd()` for this run. Always set; mirrors
   * whatever env the executor wired (a `WorktreeEnvironment`'s
   * `worktreePath`, or a bare `LocalEnvironment`'s `cwd`). Surfaced to
   * the model as `cwd:` so every llm call sees a uniform
   * `<environment>` block regardless of env implementation — no
   * brittle structural probe for `worktreePath`. */
  cwd: string;
  /** Opaque session id, stable across the whole run. Surfaced to the
   * agent as `run_id:` so artifacts can cite their producing run. */
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
  /** Tier-1 sub-agent catalogue block (empty when the `agent` tool isn't
   * in the pool or no profiles are discovered). Prepended after skills
   * and before the protocol block so spawn affordances sit alongside
   * the tool advertisements that frame them. */
  agentsCatalog?: string;
  /** Per-run isolation facts (cwd, bootstrap status). Rendered as an
   * `<environment>` block at the top so agents know where they are
   * before reading anything else. */
  runEnv?: RunEnvironment | undefined;
}

/** Inputs for the framework-blocks-only assembly (everything except the
 *  persona). Shared between the full `buildSystemPrompt` and the
 *  sub-agent assembly in `materialiseForChild`. */
export interface BuildFrameworkBlocksInput {
  contextBlock: string;
  skillsCatalog?: string;
  agentsCatalog?: string;
  runEnv?: RunEnvironment | undefined;
}

/** Assemble everything that frames a persona — env / protocol / agents
 *  catalogue / skills catalogue / project conventions — without the
 *  persona itself. The persona is appended by callers (`buildSystemPrompt`
 *  for llm nodes, `materialiseForChild` for sub-agents). Order is
 *  identical to the full assembly so the framework parts compose
 *  identically whether the consumer is a parent or a child. */
export function buildFrameworkBlocks({
  contextBlock,
  skillsCatalog,
  agentsCatalog,
  runEnv,
}: BuildFrameworkBlocksInput): string {
  const skillsBlock = skillsCatalog ?? "";
  const agentsBlock = agentsCatalog ?? "";
  // Prepend order (top → bottom of the assembled framework block):
  //   <environment>   — where the agent is running
  //   agents catalog  — named sub-agents the LLM can spawn (when `agent` tool present)
  //   skills catalog  — what tools / skills are available
  //   project conv.   — AGENTS.md and friends
  let out = contextBlock;
  out = mergeSystemPrompt(out, skillsBlock);
  out = mergeSystemPrompt(out, agentsBlock);
  if (runEnv !== undefined) {
    out = mergeSystemPrompt(out, renderRunEnvironment(runEnv));
  }
  return out;
}

/** Assemble the final system prompt for a single agent call. Isolated from
 * the backend so tests can round-trip the combinator without standing up
 * pi-agent-core, and so the thread/cache layer in `./thread.ts` can
 * compose it without duplicating the merge rules. */
export function buildSystemPrompt({
  global,
  perNode,
  contextBlock,
  skillsCatalog,
  agentsCatalog,
  runEnv,
}: BuildSystemPromptInput): string {
  const base = perNode !== undefined && perNode.length > 0 ? perNode : global;
  const framework = buildFrameworkBlocks({
    contextBlock,
    ...(skillsCatalog !== undefined ? { skillsCatalog } : {}),
    ...(agentsCatalog !== undefined ? { agentsCatalog } : {}),
    runEnv,
  });
  return mergeSystemPrompt(base, framework);
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
  const cwd = env.cwd;
  const lines: string[] = [
    "<environment>",
    `cwd: ${cwd}`,
    `run_id: ${env.runId}`,
    "- Bash starts in cwd; run commands directly.",
    "  ✅ pwd",
    `  ❌ cd ${cwd} && pwd`,
    "- File tools resolve paths relative to cwd.",
    "  ✅ README.md",
    `  ❌ ${cwd}/README.md`,
    "- Do NOT `cd` outside cwd — runtime refuses (`cd /elsewhere && …`).",
    "- Do NOT use absolute paths outside cwd — path-resolver returns a tool error.",
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
 *  in @fragua/workspace carries a few runtime-only fields (signal,
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

/** Project-conventions + run-env framing the parent assembled from
 *  `loadContextFiles` + `deriveRunEnv`. Sub-agents reuse these verbatim
 *  so they see the same project primer (AGENTS.md and friends) and
 *  worktree facts (cwd, bootstrap status) the parent saw. Optional —
 *  hand-rolled test specs may pass `{ contextBlock: "" }` and skip
 *  the env block. */
export interface ParentFrameworkInput {
  /** Pre-rendered `<project-conventions>` block. Empty when no
   *  context_files were declared on the parent node. */
  contextBlock: string;
  /** Pre-built RunEnvironment (cwd, bootstrap, runId). Omitted in
   *  tests without a worktree. */
  runEnv?: RunEnvironment;
}

/** Build the system prompt + skill catalog for a sub-agent run.
 *
 *  Order (top → bottom of the assembled child prompt):
 *    <environment>   — same cwd/bootstrap the parent had
 *    skills catalog  — child's filtered subset of the parent's catalog
 *    project conv.   — same AGENTS.md the parent saw
 *    persona         — `spec.system_prompt` (the agent definition body
 *                      or inline `system_prompt` argument), LAST so it
 *                      reads as the immediate task framing for the LLM.
 *
 *  No agents catalogue — sub-agents can't spawn grand-children (the
 *  `agent` tool is stripped from the child pool).
 *
 *  - `spec.system_prompt` is the persona / role brief. The framework
 *    blocks above frame it; this string is appended at the bottom.
 *  - `spec.skills` is intersected with the parent's loaded catalog
 *    (unknown names silently dropped). The child sees ONLY the
 *    intersected subset rendered as `<available_skills>` — never the
 *    parent's full catalog.
 *  - When the spec carries no persona AND no skills, the child still
 *    runs with the framework blocks (env + project conv) so project
 *    context survives.
 */
export function materialiseForChild(
  spec: MaterialiseChildSpec,
  parentFramework: ParentFrameworkInput,
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
  const childSkillsCatalog = effectiveSkills.length > 0 ? renderSkillsCatalog(effectiveSkills) : "";
  const framework = buildFrameworkBlocks({
    contextBlock: parentFramework.contextBlock,
    skillsCatalog: childSkillsCatalog,
    agentsCatalog: "",
    ...(parentFramework.runEnv !== undefined ? { runEnv: parentFramework.runEnv } : {}),
  });
  // Persona last: framework blocks frame the task, the persona is the
  // last thing the model reads before the user prompt.
  const systemPrompt = framework.length > 0 ? mergeSystemPrompt(persona, framework) : persona;
  return { systemPrompt, effectiveSkills };
}
