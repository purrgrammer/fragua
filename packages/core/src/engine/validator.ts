// Graph linter. Catches structural and semantic issues before execution.
// See docs/SPEC.md §4.1 (validation phase).

import type { Edge, Graph, NodeAttrs } from "../types/graph.ts";
import { isOutputRecord, type OutputProfile } from "../types/outputs.ts";
import { fanoutBranchClosures } from "./fanout.ts";
import { validateOutputsDeclStatic } from "./outputs-profile.ts";
import { isRetryPresetName, RETRY_PRESETS } from "./retry-policy.ts";
import { inputReferences, outputReferences } from "./substitution.ts";

/** Whitelist of known node attribute names — the IR (snake_case) field set
 * the validator runs against, *after* the parser has lowered authoring keys
 * (`thread:` → `thread_id`, `context-files:` →
 * `context_files`, …). Anything outside this set trips W013, surfacing typos
 * and parser passthrough that would otherwise silently no-op. Keep in sync
 * with `NodeAttrs` declared fields in `types/graph.ts` — drift in either
 * direction fails `test/lint.test.ts`. */
const KNOWN_NODE_ATTRS: ReadonlySet<string> = new Set([
  "label",
  "type",
  "prompt",
  "system_prompt",
  "context_files",
  "skills_disabled",
  "model",
  "provider",
  "summary",
  "thread_id",
  "goal_gate",
  "max_retries",
  "timeout",
  "max_ms",
  "reasoning_effort",
  "allowed_tools",
  "denied_tools",
  "retry_target",
  "tool_command",
  "max_cost_usd",
  "max_tokens",
  "skills",
  "routes",
  "text",
  "retry_policy",
  "retry_initial_delay_ms",
  "retry_backoff_factor",
  "retry_max_delay_ms",
  "retry_jitter",
  "outputs",
  "branches",
  "concurrency",
  "join",
]);

/** Whitelist of known edge attribute names. See KNOWN_NODE_ATTRS. */
const KNOWN_EDGE_ATTRS: ReadonlySet<string> = new Set(["label", "thread_id", "outcome", "route", "fanout"]);

/** Tools that can mutate the shared worktree. A fan-out branch (read-class,
 * deliberation-only) may not reach any — concurrent writes corrupt the shared
 * snapshot nondeterministically and won't replay (E042). */
const WRITE_CLASS_TOOLS: ReadonlySet<string> = new Set(["bash", "write", "edit"]);

/** Write-class tools a node can reach. An llm node with no `allowed-tools` gets
 * the full toolset (so every write-class tool minus `denied-tools`); an
 * `allowed-tools` list narrows to its intersection with the write-class set. */
function writeReachableTools(attrs: NodeAttrs): string[] {
  const denied = new Set(attrs.denied_tools ?? []);
  const candidates = attrs.allowed_tools !== undefined ? attrs.allowed_tools : [...WRITE_CLASS_TOOLS];
  return candidates.filter((t) => WRITE_CLASS_TOOLS.has(t) && !denied.has(t));
}

/** Whitelist of known graph attribute names. See KNOWN_NODE_ATTRS. */
const KNOWN_GRAPH_ATTRS: ReadonlySet<string> = new Set([
  "goal",
  "label",
  "thread_id",
  "budget_usd",
  "budget_policy",
  "inputs",
  "outputs",
  "default_retry_policy",
]);

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** Optional node or edge reference for UI highlighting. */
  nodeId?: string;
  edge?: { from: string; to: string };
  loc?: { line: number; col: number };
}

export interface ValidateOptions {
  /** Treat warnings as errors (useful for CI). */
  strict?: boolean;
}

export class ValidationError extends Error {
  constructor(public readonly diagnostics: Diagnostic[]) {
    super(`graph validation failed: ${diagnostics.length} issues`);
    this.name = "ValidationError";
  }
}

export function validate(graph: Graph, opts: ValidateOptions = {}): Diagnostic[] {
  const diags: Diagnostic[] = [];

  const nodes = Object.values(graph.nodes);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const starts = nodes.filter((n) => n.type === "start");
  const exits = nodes.filter((n) => n.type === "exit");

  // E001: start node required
  if (starts.length === 0) {
    diags.push({ severity: "error", code: "E001", message: "graph has no start node (start)" });
  }
  if (starts.length > 1) {
    diags.push({
      severity: "error",
      code: "E002",
      message: `graph has multiple start nodes: ${starts.map((s) => s.id).join(", ")}`,
    });
  }

  // E003: exit node required
  if (exits.length === 0) {
    diags.push({ severity: "error", code: "E003", message: "graph has no exit node (exit)" });
  }

  // E004: edge references undefined node
  for (const e of graph.edges) {
    if (!nodeIds.has(e.from)) {
      diags.push({
        severity: "error",
        code: "E004",
        message: `edge references undefined source node "${e.from}"`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
    if (!nodeIds.has(e.to)) {
      diags.push({
        severity: "error",
        code: "E004",
        message: `edge references undefined target node "${e.to}"`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // W001: orphan node (no in-edges, not start)
  const inDegrees = new Map<string, number>();
  for (const n of nodes) inDegrees.set(n.id, 0);
  for (const e of graph.edges) {
    inDegrees.set(e.to, (inDegrees.get(e.to) ?? 0) + 1);
  }
  for (const n of nodes) {
    if (n.type === "start") continue;
    if ((inDegrees.get(n.id) ?? 0) === 0) {
      diags.push({
        severity: "warning",
        code: "W001",
        message: `node "${n.id}" has no incoming edges (orphan)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W002: unreachable from start
  if (starts.length === 1) {
    const reachable = reachableSet(graph, starts[0]!.id);
    for (const n of nodes) {
      if (!reachable.has(n.id)) {
        diags.push({
          severity: "warning",
          code: "W002",
          message: `node "${n.id}" is not reachable from start`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E012: start node must have no incoming edges. The
  // start handler is the entry point and is reached by the run-started
  // fact, not by any edge.
  for (const s of starts) {
    if ((inDegrees.get(s.id) ?? 0) > 0) {
      diags.push({
        severity: "error",
        code: "E012",
        message: `start node "${s.id}" must have no incoming edges`,
        nodeId: s.id,
        ...(s.loc !== undefined ? { loc: s.loc } : {}),
      });
    }
  }

  // E013: exit nodes must have no outgoing edges.
  for (const e of exits) {
    const out = graph.edges.filter((edge) => edge.from === e.id);
    if (out.length > 0) {
      diags.push({
        severity: "error",
        code: "E013",
        message: `exit node "${e.id}" must have no outgoing edges`,
        nodeId: e.id,
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // W009: llm (box) node has empty prompt and empty label. The agent
  // boundary substitutes label for prompt when prompt is empty; both
  // empty leaves the LLM call with nothing to do. Catches "I forgot the
  // prompt" authoring mistakes.
  for (const n of nodes) {
    if (n.type !== "llm") continue;
    const promptEmpty = !(typeof n.attrs.prompt === "string" && n.attrs.prompt.trim() !== "");
    const labelEmpty = !(typeof n.attrs.label === "string" && n.attrs.label.trim() !== "");
    if (promptEmpty && labelEmpty) {
      diags.push({
        severity: "warning",
        code: "W009",
        message: `llm node "${n.id}" has empty prompt and empty label — the LLM call will have nothing to do`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E027: summary= requires thread_id. Summarising nothing makes no sense —
  // fresh nodes have no prior thread to compress. Value-set validation is
  // parser-side via ENUM_KEYS (low|medium|high), so by the time we reach
  // here `summary` is already one of the three valid levels.
  for (const n of nodes) {
    const s = n.attrs.summary;
    if (typeof s === "string" && (s as string) !== "") {
      const hasNodeThread = typeof n.attrs.thread_id === "string" && (n.attrs.thread_id as string) !== "";
      const hasGraphThread = typeof graph.attrs.thread_id === "string" && (graph.attrs.thread_id as string) !== "";
      if (!hasNodeThread && !hasGraphThread) {
        diags.push({
          severity: "error",
          code: "E027",
          message: `node "${n.id}" sets summary="${s}" but has no thread_id — summarising nothing has no effect`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E028: `exit` is reserved as the canonical graceful-halt sink. A node
  // named `exit` must declare `type: exit` — any other type would shadow
  // the reserved name and confuse readers (and a future implicit-sink
  // implementation that bypasses declaration entirely).
  for (const n of nodes) {
    if (n.id !== "exit") continue;
    if (n.type === "exit") continue;
    diags.push({
      severity: "error",
      code: "E028",
      message: `node id "exit" is reserved for the graceful-halt sink — declare it as \`type: exit\` or rename`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // E029: `start` is reserved for the synthesized entry node. Authors
  // never declare it; the parser injects it pointing at the first step.
  // Surfaces if a hand-built or tool-generated graph names a step `start`
  // with any type other than `start`.
  for (const n of nodes) {
    if (n.id !== "start") continue;
    if (n.type === "start") continue;
    diags.push({
      severity: "error",
      code: "E029",
      message: `node id "start" is reserved for the synthesized entry node — rename this step`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // E030: `${{ inputs.x }}` references an input not declared in the
  // workflow's `inputs:` block. Substitution would silently collapse the
  // placeholder to "" at runtime, so catch the typo / missing declaration
  // at validate-time. Scans the substituted-string attrs (prompt / text /
  // tool_command) on every node.
  {
    const declared = new Set((graph.attrs.inputs ?? []).map((d) => d.name));
    for (const n of nodes) {
      const fields = [n.attrs.prompt, n.attrs.text, n.attrs.tool_command];
      const seen = new Set<string>();
      for (const f of fields) {
        if (typeof f !== "string") continue;
        for (const ref of inputReferences(f)) {
          if (declared.has(ref) || seen.has(ref)) continue;
          seen.add(ref);
          diags.push({
            severity: "error",
            code: "E030",
            message: `node "${n.id}" references undeclared input \`${ref}\` — add it to the inputs: block`,
            nodeId: n.id,
            ...(n.loc !== undefined ? { loc: n.loc } : {}),
          });
        }
      }
    }
  }

  // E009: human node needs ≥1 outgoing edge — otherwise the operator has
  // no choices. Human nodes declare those choices via routes= (for the
  // route-discriminated model) or bare edges; either way an edgeless human
  // node is always a dead end. Catches the construction failure at
  // validate-time so bad workflows never enqueue.
  for (const n of nodes) {
    if (n.type !== "human") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    if (out.length === 0) {
      diags.push({
        severity: "error",
        code: "E009",
        message: `human node "${n.id}" has no outgoing edges and no routes= (operator would have no choices)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E008: tool node (tool node) must carry a non-empty `tool_command`.
  // Without it the executor has nothing to spawn and halts at dispatch.
  for (const n of nodes) {
    if (n.type !== "tool") continue;
    const cmd = n.attrs.tool_command;
    if (typeof cmd !== "string" || cmd.trim().length === 0) {
      diags.push({
        severity: "error",
        code: "E008",
        message: `tool node "${n.id}" must define a non-empty \`tool_command\` attribute`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E011: a node's `retry_target` references an undefined node. Catches a
  // typo that would otherwise silently halt the run with
  // `goal_gate_unsatisfied` at the worst possible moment.
  for (const n of nodes) {
    const target = n.attrs.retry_target;
    if (typeof target !== "string" || target === "") continue;
    if (!nodeIds.has(target)) {
      diags.push({
        severity: "error",
        code: "E011",
        message: `node "${n.id}" retry_target="${target}" references undefined node`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // W014: unrecognised retry_policy / default_retry_policy preset name.
  // Unknown values silently fall back to "none" at runtime; surface the
  // typo at validate-time so the author knows they got no backoff.
  {
    const validNames = Object.keys(RETRY_PRESETS)
      .map((n) => JSON.stringify(n))
      .join(", ");
    for (const n of nodes) {
      const policy = (n.attrs as Record<string, unknown>)["retry_policy"];
      if (policy !== undefined && !isRetryPresetName(policy)) {
        diags.push({
          severity: "warning",
          code: "W014",
          message: `node "${n.id}" retry-policy="${policy}" is not a known preset (expected one of ${validNames}) — falls back to "none" at runtime`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
    const graphPolicy = (graph.attrs as Record<string, unknown>)["default_retry_policy"];
    if (graphPolicy !== undefined && !isRetryPresetName(graphPolicy)) {
      diags.push({
        severity: "warning",
        code: "W014",
        message: `graph default-retry-policy="${graphPolicy}" is not a known preset (expected one of ${validNames}) — falls back to "none" at runtime`,
      });
    }
  }

  // W007: node with goal_gate=true has no retarget. A goal gate without a
  // retry_target can only halt the run on failure, never recover —
  // almost certainly an authoring oversight.
  for (const n of nodes) {
    if (n.attrs.goal_gate !== true) continue;
    const hasGateTarget = typeof n.attrs.retry_target === "string" && n.attrs.retry_target !== "";
    if (!hasGateTarget) {
      diags.push({
        severity: "warning",
        code: "W007",
        message: `goal_gate node "${n.id}" has no retry_target — failure can only halt`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E031: a goal gate authored via `retry:` (goal_gate=true AND retry_target
  // set) must declare max_retries — the per-gate retarget cap is co-located
  // with the gate that owns the loop.
  for (const n of nodes) {
    if (n.attrs.goal_gate !== true) continue;
    const hasGateTarget = typeof n.attrs.retry_target === "string" && n.attrs.retry_target !== "";
    if (!hasGateTarget) continue; // W007 fires; E031 only applies when retry_target IS set
    if (typeof n.attrs.max_retries === "number") continue;
    diags.push({
      severity: "error",
      code: "E031",
      message: `goal-gate step "${n.id}" uses \`retry:\` but has no \`max-retries:\` — add a per-gate retarget cap`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // E032: a non-terminal step must declare an explicit success successor.
  // Linear-by-default fall-through was removed — every llm/tool step needs
  // `next:` / `on: {success: …}` / `routes:`, otherwise it dead-ends on
  // success. Terminate a branch by routing to the reserved `exit` sink.
  // Human steps are covered by E009 (no outgoing edges); start/exit are
  // the synthesized source/sink.
  for (const n of nodes) {
    if (n.type !== "llm" && n.type !== "tool") continue;
    const out = graph.edges.filter((e) => e.from === n.id);
    // A step has a success path if it has any outgoing edge that can fire on
    // success: an explicit `outcome: success`, a `route`, or a bare
    // unconditional edge. Only a pure `fail` edge leaves success dead-ended.
    const hasSuccessPath = out.some((e) => e.attrs.outcome !== "fail");
    if (!hasSuccessPath) {
      diags.push({
        severity: "error",
        code: "E032",
        message: `step "${n.id}" declares no success successor — add \`next:\`, \`on: {success: …}\`, or \`routes:\` (use \`next: exit\` to finish)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E033/E034: static validation of the restricted outputs profile.
  // Run over every node that declares `outputs:`. Out-of-profile constructs
  // are rejected at parse time (OutputsProfileError in yaml.ts), but the
  // semantic rules (empty decl, non-identifier keys, empty choice options)
  // are emitted here as E033/E034 diagnostics rather than hard parse errors.
  // (`outputs:` on a non-llm/tool step is rejected earlier, at parse time —
  // yaml.ts throws a ParseError, like an unknown `type:`.)
  for (const n of nodes) {
    const outputs = n.attrs.outputs;
    if (outputs === undefined) continue;
    const sub = validateOutputsDeclStatic(outputs, n.id, n.loc);
    for (const d of sub) diags.push(d);
  }

  // Branch closures per parallel node — walked ONCE and shared by both
  // consumers (the W015 join-producer suppression below and the E036–E045
  // oracle later). They answer different questions about the same region, so
  // a second independent walk could silently diverge if closure semantics
  // ever evolve (nested parallel, new closure predicates).
  const closuresByParallel = new Map<string, ReturnType<typeof fanoutBranchClosures>>();
  for (const p of nodes) {
    if (p.type !== "parallel") continue;
    const join = typeof p.attrs.join === "string" ? p.attrs.join : undefined;
    const branches = Array.isArray(p.attrs.branches) ? p.attrs.branches : [];
    closuresByParallel.set(p.id, fanoutBranchClosures(graph, { branches, join }));
  }

  // Fan-out join producers: for each `type: parallel`, every node in a branch
  // closure that converges on the join. A `wait_all` barrier guarantees every
  // branch ran before the join, so a join reading `${{ outputs.<branch>.f }}`
  // must NOT draw W015 (the standard dominance oracle treats the take-all fork
  // as select-one and would warn). Keyed by join id.
  const fanoutJoinProducers = new Map<string, Set<string>>();
  for (const p of nodes) {
    if (p.type !== "parallel") continue;
    const join = typeof p.attrs.join === "string" ? p.attrs.join : undefined;
    if (join === undefined) continue;
    const producers = fanoutJoinProducers.get(join) ?? new Set<string>();
    for (const c of closuresByParallel.get(p.id) ?? []) {
      for (const n of c.nodes) producers.add(n);
    }
    fanoutJoinProducers.set(join, producers);
  }

  // E035 / W015: `${{ outputs.X.f }}` references. Reads fail closed at runtime
  // (substituteOutputs throws → node failure), so static checking is advisory,
  // not a gate:
  //   - hard error (E035) when producer X doesn't exist, declares no outputs,
  //     doesn't declare field f, or can never reach the consumer (a dead
  //     reference — always a typo / wiring mistake);
  //   - warning (W015) when X can reach the consumer but doesn't run on every
  //     path to it — the ref might be unpopulated on some run path, where it
  //     fails closed at runtime. A consumer reachable ONLY on paths where X
  //     already ran (e.g. behind X's own `fail:` edge) is silent — X has run,
  //     even if the emission itself is not guaranteed.
  // Run-dominance is computed only to SUPPRESS the warning; it never blocks.
  // The runtime guarantee is fail-closed reads, not this analysis.
  {
    const dominance = buildRunDominance(graph);
    const reachableCache = new Map<string, Set<string>>();
    const producerReaches = (producerId: string, consumerId: string): boolean => {
      let set = reachableCache.get(producerId);
      if (set === undefined) {
        set = reachableSet(graph, producerId);
        reachableCache.set(producerId, set);
      }
      return set.has(consumerId);
    };
    for (const n of nodes) {
      if (n.type === "start" || n.type === "exit") continue;
      const fields = [n.attrs.prompt, n.attrs.text, n.attrs.tool_command];
      for (const f of fields) {
        if (typeof f !== "string") continue;
        for (const ref of outputReferences(f)) {
          const producer = graph.nodes[ref.producer];
          const refToken = `\${{ outputs.${ref.producer}.${ref.path.join(".") || "?"} }}`;
          if (producer === undefined) {
            diags.push({
              severity: "error",
              code: "E035",
              message: `node "${n.id}" references \`${refToken}\` but node "${ref.producer}" does not exist`,
              nodeId: n.id,
              ...(n.loc !== undefined ? { loc: n.loc } : {}),
            });
            continue;
          }
          const producerOutputs = producer.attrs.outputs;
          if (producerOutputs === undefined) {
            diags.push({
              severity: "error",
              code: "E035",
              message: `node "${n.id}" references \`${refToken}\` but node "${ref.producer}" declares no \`outputs:\``,
              nodeId: n.id,
              ...(n.loc !== undefined ? { loc: n.loc } : {}),
            });
            continue;
          }
          const topField = ref.path[0];
          const topProfile = topField === undefined ? undefined : producerOutputs[topField];
          if (topProfile === undefined) {
            diags.push({
              severity: "error",
              code: "E035",
              message: `node "${n.id}" references \`${refToken}\` but node "${ref.producer}" does not declare output field "${topField ?? "?"}"`,
              nodeId: n.id,
              ...(n.loc !== undefined ? { loc: n.loc } : {}),
            });
            continue;
          }
          // Validate the deeper dotted segments against the field's profile: a
          // record must declare each next segment; dotting into a scalar or array
          // can never resolve (resolveSegments returns undefined → fails closed),
          // so it's a dead reference — E035, not just a top-field check.
          let segProfile: OutputProfile = topProfile;
          let badPath = false;
          // Top-level fields are always required (top-level `optional:` is
          // rejected at parse time), so only deeper segments can be optional. A
          // ref reaching through an optional field the producer may omit fails
          // closed at runtime — remember the first such segment for W016.
          let optionalSeg: string | undefined;
          for (const seg of ref.path.slice(1)) {
            if (!isOutputRecord(segProfile)) {
              badPath = true;
              break;
            }
            const next = segProfile.fields[seg];
            if (next === undefined) {
              badPath = true;
              break;
            }
            if (optionalSeg === undefined && !segProfile.required.includes(seg)) optionalSeg = seg;
            segProfile = next;
          }
          if (badPath) {
            diags.push({
              severity: "error",
              code: "E035",
              message: `node "${n.id}" references \`${refToken}\` but node "${ref.producer}" does not declare the field path \`${ref.path.join(".")}\``,
              nodeId: n.id,
              ...(n.loc !== undefined ? { loc: n.loc } : {}),
            });
            continue;
          }
          // Producer exists and declares the field. Decide error-vs-warn:
          // can't reach the consumer at all → dead ref (E035); reachable but
          // not run-dominating → advisory (W015), fail-closed at runtime.
          if (dominance.dominates(ref.producer, n.id)) {
            // Producer always runs first, so W015 stays silent — but the read can
            // still fail closed if it reaches through an optional field the
            // producer legitimately omits. W016 covers exactly that gap (a ref
            // never draws both W015 and W016).
            if (optionalSeg !== undefined) {
              diags.push({
                severity: "warning",
                code: "W016",
                message:
                  `node "${n.id}" reads \`${refToken}\` through the optional field "${optionalSeg}" — ` +
                  `if "${ref.producer}" emits without it the read fails closed at runtime (node failure, not "") — ` +
                  `read it only where "${ref.producer}" guarantees it, or drop \`optional:\` if it's always emitted`,
                nodeId: n.id,
                ...(n.loc !== undefined ? { loc: n.loc } : {}),
              });
            }
            continue;
          }
          if (!producerReaches(ref.producer, n.id)) {
            diags.push({
              severity: "error",
              code: "E035",
              message:
                `node "${n.id}" references \`${refToken}\` but "${ref.producer}" can never run before "${n.id}" ` +
                `(no path reaches the consumer after the producer) — the reference is always unpopulated`,
              nodeId: n.id,
              ...(n.loc !== undefined ? { loc: n.loc } : {}),
            });
            continue;
          }
          // A fan-out join reading its own branches' outputs: the wait_all
          // barrier guarantees every branch ran, so suppress the dominance
          // warning (the take-all fork is an AND-join the OR-based dominance
          // oracle can't express).
          if (fanoutJoinProducers.get(n.id)?.has(ref.producer)) continue;
          diags.push({
            severity: "warning",
            code: "W015",
            message:
              `node "${n.id}" reads \`${refToken}\` but "${ref.producer}" does not run on every path to it — ` +
              `if it didn't run, the reference fails closed at runtime (node failure, not "")`,
            nodeId: n.id,
            ...(n.loc !== undefined ? { loc: n.loc } : {}),
          });
        }
      }
    }
  }

  // W005: duplicate edges (same from/to pair with identical attributes)
  const seen = new Map<string, Edge>();
  for (const e of graph.edges) {
    const key = `${e.from}→${e.to}:${JSON.stringify(e.attrs)}`;
    if (seen.has(key)) {
      diags.push({
        severity: "warning",
        code: "W005",
        message: `duplicate edge "${e.from}" → "${e.to}" with identical attributes`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    } else {
      seen.set(key, e);
    }
  }

  // W006: cycles without an exit reachable from the cycle
  const exitIds = new Set(exits.map((e) => e.id));
  for (const sccNodes of stronglyConnectedComponents(graph)) {
    if (sccNodes.length < 2 && !hasSelfLoop(graph, sccNodes[0]!)) continue; // not a cycle
    const reachable = reachableFromSet(graph, sccNodes);
    const hasExit = [...reachable].some((id) => exitIds.has(id));
    if (!hasExit) {
      diags.push({
        severity: "error",
        code: "E006",
        message: `cycle ${sccNodes.join(" → ")} has no reachable exit node`,
      });
    }
  }

  // E017: routing node (non-empty routes=) must not have outgoing edges
  // keyed by outcome=. Routing nodes discriminate by route=; mixing the
  // two discriminators on the same source node is always ambiguous.
  for (const n of nodes) {
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length === 0) continue;
    for (const e of graph.edges) {
      if (e.from !== n.id) continue;
      if (typeof e.attrs.outcome !== "string") continue;
      diags.push({
        severity: "error",
        code: "E017",
        message: `routing node "${n.id}" has edge "${e.from}" → "${e.to}" with outcome="${e.attrs.outcome}" — routing nodes discriminate by route=, not outcome=`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // E018: a single edge must not carry both outcome= and route=. An edge
  // is discriminated by exactly one of the two; both together is
  // always a model error.
  for (const e of graph.edges) {
    const hasOutcome = typeof e.attrs.outcome === "string";
    const hasRoute = typeof e.attrs.route === "string" && e.attrs.route !== "";
    if (hasOutcome && hasRoute) {
      diags.push({
        severity: "error",
        code: "E018",
        message: `edge "${e.from}" → "${e.to}" sets both outcome="${e.attrs.outcome}" and route="${e.attrs.route}" — use exactly one discriminator`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // E019: edge with route= must reference a value that the source node
  // declares in routes=. Route values not declared at the source node
  // can never be selected and indicate an authoring mistake (typo or
  // stale edge after a routes= edit).
  for (const e of graph.edges) {
    const edgeRoute = e.attrs.route;
    if (typeof edgeRoute !== "string" || edgeRoute === "") continue;
    const src = graph.nodes[e.from];
    if (src === undefined) continue; // E004 already fired
    const declared = Array.isArray(src.attrs.routes) ? src.attrs.routes : [];
    if (declared.length === 0) {
      diags.push({
        severity: "error",
        code: "E019",
        message: `edge "${e.from}" → "${e.to}" has route="${edgeRoute}" but source node "${e.from}" declares no routes=`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    } else if (!declared.includes(edgeRoute)) {
      diags.push({
        severity: "error",
        code: "E019",
        message: `edge "${e.from}" → "${e.to}" has route="${edgeRoute}" but source node "${e.from}" only declares routes="${declared.join(",")}"`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }

  // E020: every outgoing edge from a routing node must carry exactly one
  // of route= or outcome=. An unannotated edge from a routing node
  // would be selected by an unrelated discriminator (or never), making
  // the intent of the edge ambiguous.
  for (const n of nodes) {
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length === 0) continue;
    for (const e of graph.edges) {
      if (e.from !== n.id) continue;
      const hasOutcome = typeof e.attrs.outcome === "string";
      const hasRoute = typeof e.attrs.route === "string" && e.attrs.route !== "";
      if (!hasOutcome && !hasRoute) {
        diags.push({
          severity: "error",
          code: "E020",
          message: `routing node "${n.id}" has edge "${e.from}" → "${e.to}" with neither route= nor outcome= — every edge from a routing node must be annotated`,
          edge: { from: e.from, to: e.to },
          ...(e.loc !== undefined ? { loc: e.loc } : {}),
        });
      }
    }
  }

  // E021: every value declared in routes= must have a matching outgoing
  // edge with route=<value>. Undischarged routes can never be taken;
  // they represent a missing edge or a renamed route value.
  for (const n of nodes) {
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length === 0) continue;
    const coveredRoutes = new Set(
      graph.edges.filter((e) => e.from === n.id && typeof e.attrs.route === "string").map((e) => e.attrs.route),
    );
    for (const r of routes) {
      if (!coveredRoutes.has(r)) {
        diags.push({
          severity: "error",
          code: "E021",
          message: `routing node "${n.id}" declares route "${r}" in routes= but no outgoing edge has route="${r}"`,
          nodeId: n.id,
          ...(n.loc !== undefined ? { loc: n.loc } : {}),
        });
      }
    }
  }

  // E022: human nodes must declare routes= so the operator has a defined
  // set of choices. A human node with no routes= has no structured
  // vocabulary for operator dispatch.
  for (const n of nodes) {
    if (n.type !== "human") continue;
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length === 0) {
      diags.push({
        severity: "error",
        code: "E022",
        message: `human node "${n.id}" has no routes= declaration — operator needs at least one named route`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E023: goal_gate and routes= are mutually exclusive. A goal gate
  // is a binary pass/fail evaluation; routing is LLM-directed
  // multi-branch selection. Combining them would make the node's exit
  // semantics undefined.
  for (const n of nodes) {
    if (n.attrs.goal_gate !== true) continue;
    const routes = Array.isArray(n.attrs.routes) ? n.attrs.routes : [];
    if (routes.length > 0) {
      diags.push({
        severity: "error",
        code: "E023",
        message: `node "${n.id}" combines goal_gate=true with routes= — these are mutually exclusive exit strategies`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }

  // E024: duplicate discriminator values from the same source node.
  // Two edges sharing the same outcome= or the same route= from a
  // single source are ambiguous: the engine cannot decide which to
  // take, and one of the edges is permanently shadowed.
  {
    const sourceEdges = new Map<string, typeof graph.edges>();
    for (const e of graph.edges) {
      const list = sourceEdges.get(e.from) ?? [];
      list.push(e);
      sourceEdges.set(e.from, list);
    }
    for (const [fromId, edges] of sourceEdges) {
      const outcomeCounts = new Map<string, number>();
      const routeCounts = new Map<string, number>();
      for (const e of edges) {
        if (typeof e.attrs.outcome === "string") {
          outcomeCounts.set(e.attrs.outcome, (outcomeCounts.get(e.attrs.outcome) ?? 0) + 1);
        }
        if (typeof e.attrs.route === "string" && e.attrs.route !== "") {
          routeCounts.set(e.attrs.route, (routeCounts.get(e.attrs.route) ?? 0) + 1);
        }
      }
      for (const [val, count] of outcomeCounts) {
        if (count < 2) continue;
        diags.push({
          severity: "error",
          code: "E024",
          message: `node "${fromId}" has ${count} edges with outcome="${val}" — each outcome= value must appear at most once per source`,
          nodeId: fromId,
        });
      }
      for (const [val, count] of routeCounts) {
        if (count < 2) continue;
        diags.push({
          severity: "error",
          code: "E024",
          message: `node "${fromId}" has ${count} edges with route="${val}" — each route= value must appear at most once per source`,
          nodeId: fromId,
        });
      }
    }
  }

  // E026: text= is a human-node attribute (the prompt shown to the
  // operator). Setting it on a non-human node has no effect at runtime;
  // the diagnostic surfaces the authoring mistake at validate-time.
  for (const n of nodes) {
    if (typeof n.attrs.text !== "string" || n.attrs.text === "") continue;
    if (n.type === "human") continue;
    diags.push({
      severity: "error",
      code: "E026",
      message: `node "${n.id}" sets text= but is not a human node (type="${n.type}") — text= is only meaningful on human nodes`,
      nodeId: n.id,
      ...(n.loc !== undefined ? { loc: n.loc } : {}),
    });
  }

  // W013: unrecognised attribute name. Cast to Record<string, unknown> at
  // the read site so the typed attrs objects remain indexable here without
  // an index signature.
  for (const n of nodes) {
    for (const key of Object.keys(n.attrs as Record<string, unknown>)) {
      if (KNOWN_NODE_ATTRS.has(key)) continue;
      diags.push({
        severity: "warning",
        code: "W013",
        message: `node "${n.id}" has unrecognised attribute "${key}" — typo? (see packages/core/src/types/graph.ts NodeAttrs for the canonical list)`,
        nodeId: n.id,
        ...(n.loc !== undefined ? { loc: n.loc } : {}),
      });
    }
  }
  for (const e of graph.edges) {
    for (const key of Object.keys(e.attrs as Record<string, unknown>)) {
      if (KNOWN_EDGE_ATTRS.has(key)) continue;
      diags.push({
        severity: "warning",
        code: "W013",
        message: `edge "${e.from}" → "${e.to}" has unrecognised attribute "${key}" — typo? (see EdgeAttrs for the canonical list)`,
        edge: { from: e.from, to: e.to },
        ...(e.loc !== undefined ? { loc: e.loc } : {}),
      });
    }
  }
  for (const key of Object.keys(graph.attrs as Record<string, unknown>)) {
    if (KNOWN_GRAPH_ATTRS.has(key)) continue;
    diags.push({
      severity: "warning",
      code: "W013",
      message: `graph has unrecognised attribute "${key}" — typo? (see GraphAttrs for the canonical list)`,
    });
  }

  // ── E036–E044: `type: parallel` fan-out well-formedness (Model A,
  // docs/proposals/fan-out-nodes.md). A branch entry begins a sub-pipeline (its
  // closure of intra-fan-out nodes) that converges on the join; every closure
  // node is a distinct, read-class llm node and the closure is an acyclic DAG
  // terminating at the join. E038 is the structural "join not a defined step";
  // E044 is the disjointness invariant ("a node is shared by two branches") —
  // distinct conditions a machine consumer keys on separately.
  const nonFanoutEdgesFrom = (id: string): Edge[] =>
    graph.edges.filter((e) => e.from === id && e.attrs.fanout !== true);
  for (const p of nodes) {
    if (p.type !== "parallel") continue;
    const branches = Array.isArray(p.attrs.branches) ? p.attrs.branches : [];
    const join = typeof p.attrs.join === "string" ? p.attrs.join : undefined;
    const loc = p.loc !== undefined ? { loc: p.loc } : {};

    if (branches.length < 2) {
      diags.push({
        severity: "error",
        code: "E036",
        message: `parallel node "${p.id}" must declare ≥2 branches (has ${branches.length})`,
        nodeId: p.id,
        ...loc,
      });
    }
    // The seed fact (`fact.fanout_started`) embeds the full branch list in
    // its payload, and event payloads are capped at 4 KiB (I7). Without this
    // bound a wide-enough fan-out validates cleanly and then dies at the
    // seed commit with an "executor crashed" halt that points nowhere near
    // the authoring problem. 3 KiB leaves headroom for the other fields.
    if (JSON.stringify(branches).length > 3072) {
      diags.push({
        severity: "error",
        code: "E045",
        message: `parallel node "${p.id}" declares too many branches (${branches.length}) — the serialized branch list exceeds the 4 KiB event-payload budget`,
        nodeId: p.id,
        ...loc,
      });
    }
    const seenEntries = new Set<string>();
    for (const b of branches) {
      if (seenEntries.has(b) || !nodeIds.has(b)) {
        diags.push({
          severity: "error",
          code: "E037",
          message: `parallel node "${p.id}" branch "${b}" is ${seenEntries.has(b) ? "a duplicate" : "not a defined step"}`,
          nodeId: p.id,
          ...loc,
        });
      }
      seenEntries.add(b);
    }
    if (join === undefined || !nodeIds.has(join)) {
      diags.push({
        severity: "error",
        code: "E038",
        message: `parallel node "${p.id}" join "${join ?? "(none)"}" is not a defined step`,
        nodeId: p.id,
        ...loc,
      });
      continue;
    }

    // Per-branch closure via the shared walk (engine/fanout.ts) — the same node
    // set the executor budgets over and the UI groups by, so the legality
    // oracle can't drift from the runtime scope. Ownership tracking catches
    // overlapping branches (E044).
    const owner = new Map<string, string>();
    for (const bc of closuresByParallel.get(p.id) ?? []) {
      const entry = bc.entry;
      if (!nodeIds.has(entry)) continue;
      const closure = bc.nodes;
      for (const x of closure) {
        const prevOwner = owner.get(x);
        if (prevOwner !== undefined && prevOwner !== entry) {
          diags.push({
            severity: "error",
            code: "E044",
            message: `node "${x}" is shared by branches "${prevOwner}" and "${entry}" of parallel "${p.id}" — branches must be disjoint`,
            nodeId: x,
            ...loc,
          });
        }
        owner.set(x, entry);
      }
      if (!bc.reachesJoin) {
        diags.push({
          severity: "error",
          code: "E039",
          message: `branch "${entry}" of parallel "${p.id}" never reaches the join "${join}" (no path out — a cycle or dead-end closure)`,
          nodeId: entry,
          ...loc,
        });
      }

      // W017: a cycle inside the branch closure (a back-edge to a node still on
      // the DFS stack) can spin until the per-branch timeout fires. A bounded
      // retry — `max_retries` or a goal gate — is legitimate, so this WARNS
      // rather than erroring; an unbounded loop is almost always an authoring
      // slip the runtime backstop only papers over. (E039 above catches a closure
      // that can't reach the join at all; this catches one that can but may loop.)
      const closureSet = new Set(closure);
      const dfsState = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
      let cyclic = false;
      for (const root of closure) {
        if (dfsState.has(root)) continue;
        const stack: Array<{ node: string; succ: string[]; i: number }> = [
          { node: root, succ: nonFanoutEdgesFrom(root).map((e) => e.to), i: 0 },
        ];
        dfsState.set(root, 1);
        while (stack.length > 0) {
          const top = stack[stack.length - 1]!;
          if (top.i >= top.succ.length) {
            dfsState.set(top.node, 2);
            stack.pop();
            continue;
          }
          const to = top.succ[top.i++]!;
          if (to === join || !closureSet.has(to)) continue;
          const seenState = dfsState.get(to);
          if (seenState === 1) {
            cyclic = true;
            break;
          }
          if (seenState === undefined) {
            stack.push({ node: to, succ: nonFanoutEdgesFrom(to).map((e) => e.to), i: 0 });
            dfsState.set(to, 1);
          }
        }
        if (cyclic) break;
      }
      if (cyclic) {
        diags.push({
          severity: "warning",
          code: "W017",
          message: `branch closure of "${entry}" in parallel "${p.id}" contains a cycle — it can loop until the per-branch timeout; bound it (max_retries / a goal gate) or make the closure acyclic`,
          nodeId: entry,
          ...loc,
        });
      }

      for (const nodeId of closure) {
        const cn = graph.nodes[nodeId];
        if (cn === undefined) continue;
        // E040: no nested parallel.
        if (cn.type === "parallel") {
          diags.push({
            severity: "error",
            code: "E040",
            message: `branch node "${nodeId}" of parallel "${p.id}" is itself \`type: parallel\` — nested fan-out is not supported (v1)`,
            nodeId,
            ...loc,
          });
        } else if (cn.type !== "llm") {
          // E041: deliberation-only — branch nodes must be llm.
          diags.push({
            severity: "error",
            code: "E041",
            message: `branch node "${nodeId}" of parallel "${p.id}" is \`type: ${cn.type}\` — v1 branch nodes must be \`type: llm\``,
            nodeId,
            ...loc,
          });
        } else {
          // `llm` is the only valid branch kind; the tool / thread constraints
          // apply to it alone. Running them on a node that already failed E040/
          // E041 double-fires — e.g. a nested `parallel` has no `allowed_tools`,
          // so `writeReachableTools` returns EVERY write-class tool and E042
          // piles on top of E040.
          const writeReachable = writeReachableTools(cn.attrs);
          if (writeReachable.length > 0) {
            // E042: no branch node may reach a write-class tool (shared read-only worktree).
            diags.push({
              severity: "error",
              code: "E042",
              message: `branch node "${nodeId}" of parallel "${p.id}" can reach write-class tool(s) [${writeReachable.join(", ")}] — branches share the worktree read-only; scope it with allowed-tools / denied-tools`,
              nodeId,
              ...loc,
            });
          }
          // E043: no explicit thread on a branch node (single-writer-log invariant).
          if (typeof cn.attrs.thread_id === "string") {
            diags.push({
              severity: "error",
              code: "E043",
              message: `branch node "${nodeId}" of parallel "${p.id}" declares \`thread:\` — concurrent branches each run on their own synthetic thread; pass results via typed outputs`,
              nodeId,
              ...loc,
            });
          }
        }
        // E039: every closure node's non-fanout successors stay inside the
        // closure or hit the join — no escape, and at least one successor (a
        // dead-end branch node never reaches the barrier).
        const succ = nonFanoutEdgesFrom(nodeId);
        // Skip when the branch-level E039 (never reaches the join) already
        // fired — a single-node dead-end branch trips both checks on the same
        // node, and one defect should yield one diagnostic.
        if (succ.length === 0 && bc.reachesJoin) {
          diags.push({
            severity: "error",
            code: "E039",
            message: `branch node "${nodeId}" of parallel "${p.id}" has no successor — every branch path must terminate at the join "${join}"`,
            nodeId,
            ...loc,
          });
        }
        for (const e of succ) {
          // Membership test against the explicit `closureSet` (computed for W017),
          // not the BFS `seen` — equivalent today, but `closureSet` is the
          // intended set and survives a BFS refactor that dedups/early-exits.
          if (e.to !== join && !closureSet.has(e.to)) {
            diags.push({
              severity: "error",
              code: "E039",
              message: `branch node "${nodeId}" of parallel "${p.id}" routes to "${e.to}", outside the branch closure and not the join "${join}"`,
              nodeId,
              ...loc,
            });
          }
        }
      }
    }
  }

  // E046 / W018: run-level `outputs:` projections (the top-level `outputs:`
  // block, proposal §11.4). The run BOUNDARY is typed-partial — an unproduced
  // output is absent at runtime, never a halt — so like the per-step E035/W015
  // pair, only a broken projection is a hard error; a maybe-not-produced one is
  // advisory:
  //   - E046 (hard error) when `from:` names a node that doesn't exist, declares
  //     no `outputs:`, or a `<path>` the producer's schema doesn't declare — a
  //     definite authoring bug, gated like E035.
  //   - W018 (advisory) when the producer is reachable but does not run-dominate
  //     every completing terminal — the W015 analog at the run boundary, reusing
  //     the same run-dominance oracle. A `wait_all` fan-out branch terminal is
  //     suppressed the same way W015 suppresses a join read: the barrier
  //     guarantees the branch ran before its join, so if the join run-dominates
  //     the exit the branch effectively does too.
  {
    const runOutputs = Array.isArray(graph.attrs.outputs) ? graph.attrs.outputs : [];
    if (runOutputs.length > 0) {
      const dominance = buildRunDominance(graph);
      const reachableFromStart = starts.length === 1 ? reachableSet(graph, starts[0]!.id) : new Set(nodeIds);
      const completingTerminals = exits.filter((e) => reachableFromStart.has(e.id));
      // Reverse the join-producer index (join → {branch nodes}) into branch
      // node → its join, so a run-level ref to a fan-out branch terminal can be
      // judged by its join's dominance over the exit.
      const branchNodeToJoin = new Map<string, string>();
      for (const [join, producers] of fanoutJoinProducers) {
        for (const p of producers) branchNodeToJoin.set(p, join);
      }
      for (const decl of runOutputs) {
        const fromToken = `from: ${decl.node}${decl.path.length > 0 ? `.${decl.path.join(".")}` : ""}`;
        const producer = graph.nodes[decl.node];
        if (producer === undefined) {
          diags.push({
            severity: "error",
            code: "E046",
            message: `run output "${decl.name}" (\`${fromToken}\`) references node "${decl.node}" which does not exist`,
          });
          continue;
        }
        const producerOutputs = producer.attrs.outputs;
        if (producerOutputs === undefined) {
          diags.push({
            severity: "error",
            code: "E046",
            message: `run output "${decl.name}" (\`${fromToken}\`) references node "${decl.node}" which declares no \`outputs:\``,
            nodeId: decl.node,
          });
          continue;
        }
        // Walk the dotted path against the producer's declared profile. A bare
        // `from: node` (empty path) projects the whole struct — always valid once
        // the producer declares outputs. A first segment must be a declared
        // output field; deeper segments must each resolve into a record (dotting
        // into a scalar/array is a dead path — E046, mirroring E035's badPath).
        let badPath = false;
        const [topField, ...rest] = decl.path;
        const topProfile: OutputProfile | undefined = topField === undefined ? undefined : producerOutputs[topField];
        if (topField !== undefined && topProfile === undefined) {
          badPath = true;
        } else if (topProfile !== undefined) {
          let segProfile: OutputProfile = topProfile;
          for (const seg of rest) {
            if (!isOutputRecord(segProfile)) {
              badPath = true;
              break;
            }
            const next: OutputProfile | undefined = segProfile.fields[seg];
            if (next === undefined) {
              badPath = true;
              break;
            }
            segProfile = next;
          }
        }
        if (badPath) {
          diags.push({
            severity: "error",
            code: "E046",
            message: `run output "${decl.name}" (\`${fromToken}\`) references a field path node "${decl.node}" does not declare`,
            nodeId: decl.node,
          });
          continue;
        }
        // Producer + field resolve. Advise (W018) when the producer is reachable
        // from start but does not run-dominate every completing terminal.
        if (!reachableFromStart.has(decl.node)) continue; // W002 already flags an unreachable node
        if (completingTerminals.length === 0) continue;
        const dominator = branchNodeToJoin.get(decl.node) ?? decl.node;
        const runsOnEveryCompletingPath = completingTerminals.every((e) => dominance.dominates(dominator, e.id));
        if (!runsOnEveryCompletingPath) {
          diags.push({
            severity: "warning",
            code: "W018",
            message:
              `run output "${decl.name}" reads \`${fromToken}\` but "${decl.node}" does not run on every completing path — ` +
              `it is absent from the run's outputs (typed-partial) when "${decl.node}" didn't run`,
            nodeId: decl.node,
          });
        }
      }
    }
  }

  if (opts.strict) {
    return diags.map((d) => (d.severity === "warning" ? { ...d, severity: "error" as const } : d));
  }
  return diags;
}

/** Throw if any `error`-severity diagnostics exist. */
export function validateOrThrow(graph: Graph, opts: ValidateOptions = {}): void {
  const diags = validate(graph, opts);
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new ValidationError(diags);
}

function reachableSet(graph: Graph, startId: string): Set<string> {
  return reachableFromSet(graph, [startId]);
}

export interface RunDominance {
  /**
   * Does producer X "run-dominate" consumer N — i.e. does EVERY path from
   * start to N cross X? When true, X has run by the time N does, so a
   * `${{ outputs.X.f }}` read in N is not a not-on-every-path wiring problem
   * (the emission itself is still fail-closed at runtime).
   */
  dominates(producer: string, consumer: string): boolean;
}

/**
 * Build a run-dominance oracle for `${{ outputs.X.f }}` reference checking.
 *
 * "X run-dominates N" means every path start→N crosses X — X has run (with
 * whatever outcome) before N does. This is plain control-flow dominance,
 * including over fail edges: a consumer behind X's *own* `fail:` edge, or a
 * recovery step behind another node's `fail:`, is dominated as long as no
 * path bypasses X. W015 is about wiring ("X might not have run at all"), not
 * about whether the emission succeeded — a failed-before-emit read fails
 * closed at runtime regardless of static analysis.
 *
 * Dominators via Cooper–Harvey–Kennedy ("A Simple, Fast Dominance Algorithm"):
 * iterate immediate dominators over reverse-postorder, intersecting by walking
 * up the partial tree with postorder numbers — near-linear, no per-node O(N)
 * dominator sets. Ancestor (dominance) queries are O(1) via dom-tree DFS
 * enter/exit intervals.
 */
function buildRunDominance(graph: Graph): RunDominance {
  const succ = new Map<string, string[]>();
  const ensure = (n: string): string[] => {
    let list = succ.get(n);
    if (list === undefined) {
      list = [];
      succ.set(n, list);
    }
    return list;
  };
  for (const id of Object.keys(graph.nodes)) ensure(id);
  for (const e of graph.edges) ensure(e.from).push(e.to);

  const start = Object.keys(graph.nodes).find((id) => graph.nodes[id]?.type === "start") ?? Object.keys(graph.nodes)[0];
  if (start === undefined) return { dominates: () => false };

  // Postorder + reverse-postorder over nodes reachable from start (iterative DFS).
  const postNum = new Map<string, number>();
  const visited = new Set<string>([start]);
  const rpo: string[] = [];
  {
    const stack: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const neighbors = succ.get(top.node) ?? [];
      if (top.i < neighbors.length) {
        const next = neighbors[top.i++]!;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ node: next, i: 0 });
        }
      } else {
        postNum.set(top.node, postNum.size);
        rpo.push(top.node);
        stack.pop();
      }
    }
    rpo.reverse();
  }

  // Predecessors among reachable nodes.
  const preds = new Map<string, string[]>();
  for (const n of visited) preds.set(n, []);
  for (const [u, vs] of succ) {
    if (!visited.has(u)) continue;
    for (const v of vs) if (visited.has(v)) preds.get(v)!.push(u);
  }

  // Cooper–Harvey–Kennedy immediate-dominator fixpoint.
  const idom = new Map<string, string>([[start, start]]);
  const intersect = (a: string, b: string): string => {
    let f1 = a;
    let f2 = b;
    while (f1 !== f2) {
      while (postNum.get(f1)! < postNum.get(f2)!) f1 = idom.get(f1)!;
      while (postNum.get(f2)! < postNum.get(f1)!) f2 = idom.get(f2)!;
    }
    return f1;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of rpo) {
      if (b === start) continue;
      let newIdom: string | undefined;
      for (const p of preds.get(b) ?? []) {
        if (!idom.has(p)) continue;
        newIdom = newIdom === undefined ? p : intersect(p, newIdom);
      }
      if (newIdom !== undefined && idom.get(b) !== newIdom) {
        idom.set(b, newIdom);
        changed = true;
      }
    }
  }

  // Dom-tree DFS enter/exit intervals for O(1) ancestor checks.
  const children = new Map<string, string[]>();
  for (const n of visited) children.set(n, []);
  for (const [n, d] of idom) if (n !== d) children.get(d)!.push(n);
  const enter = new Map<string, number>();
  const exit = new Map<string, number>();
  {
    let clock = 0;
    const stack: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    enter.set(start, clock++);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const ch = children.get(top.node) ?? [];
      if (top.i < ch.length) {
        const c = ch[top.i++]!;
        enter.set(c, clock++);
        stack.push({ node: c, i: 0 });
      } else {
        exit.set(top.node, clock++);
        stack.pop();
      }
    }
  }

  return {
    dominates(producer: string, consumer: string): boolean {
      // Strict dominance: a node never run-dominates itself — a self-read
      // happens before the node's own emission.
      if (producer === consumer) return false;
      const ea = enter.get(producer);
      const xa = exit.get(producer);
      const en = enter.get(consumer);
      const xn = exit.get(consumer);
      if (ea === undefined || xa === undefined || en === undefined || xn === undefined) return false;
      return ea <= en && xn <= xa;
    },
  };
}

export { buildRunDominance };

function reachableFromSet(graph: Graph, startIds: string[]): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [...startIds];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const e of graph.edges) {
      if (e.from === id && !visited.has(e.to)) stack.push(e.to);
    }
  }
  return visited;
}

function hasSelfLoop(graph: Graph, nodeId: string): boolean {
  return graph.edges.some((e) => e.from === nodeId && e.to === nodeId);
}

/** Tarjan's algorithm for strongly connected components. */
function stronglyConnectedComponents(graph: Graph): string[][] {
  const nodes = Object.keys(graph.nodes);
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const out: string[][] = [];

  const neighbors = (id: string) => graph.edges.filter((e) => e.from === id).map((e) => e.to);

  function strongConnect(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of neighbors(v)) {
      if (!index.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      out.push(component);
    }
  }

  for (const v of nodes) if (!index.has(v)) strongConnect(v);
  return out;
}
