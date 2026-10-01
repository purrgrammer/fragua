// Tool selection + gating for the LLM backend: registry select + allowlist
// gates, force-include of `abort`, MCP allow-gates + lazy materialisation, the
// per-node skills catalogue slice, and final pi-agent tool assembly. Split out
// of backend.ts. Each function takes the backend's tool-assembly deps explicitly.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { EventType, LlmInput, Outcome, OutputsDecl } from "@fragua/core";
import { byName, fail } from "@fragua/core";
import { makeHttpClient } from "@fragua/core/handler";
import type {
  AnyTool,
  ExecutionEnvironment,
  FraguaToolContext,
  McpConnector,
  Skill,
  ToolRegistry,
} from "@fragua/workspace";
import {
  filterCatalogueForRun,
  filterSkillsForNode,
  isMcpToolName,
  mcpToolPrefix,
  normalizeMcpToolRef,
  reanchorSkillsToRunTree,
  renderSkillsCatalog,
} from "@fragua/workspace";
import { buildEmitOutputTool, buildRouteTool } from "./exit-tools.ts";
import { toAgentTool } from "./tool-adapter.ts";

export interface ToolAssemblyDeps {
  registry: ToolRegistry;
  mcpConnector: McpConnector | undefined;
  skills: readonly Skill[];
  env: ExecutionEnvironment | undefined;
}

/** Resolve the effective tool set (registry select + allowlist gates) and
 * force-include `abort`. Returns an early `outcome` for every misconfig gate,
 * or the gated tool set plus the MCP-servers metadata later phases need. */
export function selectAndGateTools(
  input: LlmInput,
  deps: ToolAssemblyDeps,
):
  | { outcome: Outcome }
  | {
      finalTools: AnyTool[];
      declaredMcpServers: string[];
      mcpOnlyAllowlist: boolean;
      allow: string[] | undefined;
      deny: string[] | undefined;
    } {
  const selectOpts: { allow?: string[]; deny?: string[] } = {};
  const allow = input.node.attrs.allowed_tools as string[] | undefined;
  const deny = input.node.attrs.denied_tools as string[] | undefined;
  if (allow) selectOpts.allow = allow;
  if (deny) selectOpts.deny = deny;
  const selectedTools = deps.registry.select(selectOpts);
  // Fail loudly when the node asked for tools but the registry produced
  // none. Silent empty-tools is the worst kind of misconfig — the model
  // happily generates `<tool_call>` XML as plain text and the run looks
  // like it succeeded while nothing actually ran. Caller should populate
  // the registry (e.g. `registry.registerAll(CORE_TOOLS)`) before
  // constructing the backend. Gated on `selectedTools` (not the
  // post-skill-merge `finalTools` below) so the diagnostic still fires
  // when the registry is genuinely empty — a registry that holds only
  // the force-included `skill` is still misconfigured.
  // An `mcp__<srv>__*` allow entry names a tool materialised later (additive,
  // per mcp-servers), not a registry tool — exclude it from the gate ONLY when
  // its server is declared in `mcp-servers` (so it can actually resolve). An
  // `mcp__*` entry for an undeclared server, or with no `mcp-servers:` at all,
  // can never resolve and must still trip the gate.
  const declaredMcpServers = (input.node.attrs.mcp_servers as string[] | undefined) ?? [];
  const mcpPrefixes = declaredMcpServers.map((s) => mcpToolPrefix(s));
  const willMaterialise = (name: string): boolean =>
    isMcpToolName(name) && mcpPrefixes.some((p) => normalizeMcpToolRef(name).startsWith(p));
  // `agent` is synthesised per-call by the backend (not a registry tool), on
  // the same terms as `route` / `emit_output` — exempt it from the
  // empty-registry gate so `allowed-tools: [agent]` alone is legal.
  const gateAllow = allow?.filter((a) => !willMaterialise(a) && a !== "agent");
  // An `mcp__*` allow entry lands in `gateAllow` only when its server ISN'T in
  // `mcp-servers:` (a declared server's tools are exempted via `willMaterialise`),
  // so it can NEVER resolve. Trip on that regardless of whether a core tool was
  // also selected — otherwise `['read', 'mcp__missing__x']` would silently run
  // with just `read`, dropping the typo'd MCP entry with no signal.
  const mcpUndeclared = gateAllow?.filter((a) => isMcpToolName(a)) ?? [];
  if (mcpUndeclared.length > 0) {
    return {
      outcome: fail(
        `allowed_tools names MCP tools [${mcpUndeclared.join(", ")}] whose server is not listed in mcp-servers: — add the server to mcp-servers, or fix the tool name.`,
        { non_retryable: true },
      ),
    };
  }
  if (gateAllow && gateAllow.length > 0 && selectedTools.length === 0) {
    // The offending entries are `gateAllow`, not the whole `allow` list.
    const registered = deps.registry.list().map((t) => t.name);
    return {
      outcome: fail(
        `allowed_tools=[${gateAllow.join(", ")}] requested but none matched the backend registry (registered: [${registered.join(", ")}]). ` +
          "The registry must be populated before backend.run() — call `registry.registerAll(CORE_TOOLS)` at daemon setup.",
      ),
    };
  }
  // `allowed_tools` names ONLY `mcp__*` tools and no core tool was selected — so
  // the step's entire toolset hinges on MCP materialisation. Used by two gates
  // below (no connector wired vs connector present but nothing materialised).
  const mcpOnlyAllowlist =
    allow !== undefined && allow.length > 0 && allow.every(isMcpToolName) && selectedTools.length === 0;
  // `willMaterialise` exempts `mcp__*` allow entries from the gate above so it
  // doesn't fire before materialisation — but with no connector wired they can
  // NEVER materialise, and the post-materialisation re-check below lives inside
  // the connector-guarded block, so an mcp-only allowlist would slip through to
  // a tool-less run. Catch that here. (A connector-present-but-servers-fail case
  // is caught after materialise; a connector present with no `mcp-servers:` makes
  // `willMaterialise` false, so the standard gate above already fires.)
  if (!deps.mcpConnector && mcpOnlyAllowlist) {
    return {
      outcome: fail(
        `allowed_tools listed only MCP tools ([${allow?.join(", ")}]) but no MCP connector is configured to materialise them.`,
        { non_retryable: true },
      ),
    };
  }
  // Force-include the built-in `abort` tool. Even when the node pins
  // `allowed_tools` (excluding it) or lists it under `denied_tools`, it
  // must remain available — a universal affordance. Skipped only when the
  // registry doesn't carry it (tests with a hand-rolled registry).
  const abortTool = deps.registry.get("abort");
  let finalTools = selectedTools;
  if (abortTool && !finalTools.some((t) => t.name === "abort")) finalTools = [...finalTools, abortTool];
  return { finalTools, declaredMcpServers, mcpOnlyAllowlist, allow, deny };
}

/** Resolve the run's execution env and slice the skill catalogue down to what
 * this run + node can see. Returns an early `outcome` when no env is wired. */
export function resolveEnvAndSkills(
  input: LlmInput,
  deps: ToolAssemblyDeps,
):
  | { outcome: Outcome }
  | {
      effectiveEnv: ExecutionEnvironment;
      effectiveSkills: readonly Skill[];
      skillsCatalog: string;
      runProjectCwd: string;
    } {
  // Prefer per-call env (wired via HandlerContext → LlmInput by the executor
  // when a WorktreeProvisioner is active). Falls back to the construction-time
  // env for tests + callers that still pass a shared LocalEnvironment.
  const effectiveEnv = input.env ?? deps.env;
  if (!effectiveEnv) {
    return {
      outcome: fail(
        "PiLlmBackend: no execution environment available — configure `env` on backendOpts or wire a WorktreeProvisioner on the daemon",
      ),
    };
  }
  // Slice the discovery superset down to what this run can see: user-scope
  // records plus project-scope records whose `project_cwd` matches
  // `env.projectCwd()`, project-scope shadowing user-scope by name.
  const runProjectCwd = effectiveEnv.projectCwd();
  const runCwdSkills = reanchorSkillsToRunTree(
    filterCatalogueForRun(deps.skills, runProjectCwd),
    runProjectCwd,
    effectiveEnv.cwd(),
  );
  const nodeSkills = input.node.attrs.skills as string[] | undefined;
  const skillFilter: { skills?: readonly string[]; skills_disabled?: boolean } = {};
  if (nodeSkills !== undefined) skillFilter.skills = nodeSkills;
  if (input.node.attrs.skills_disabled === true) skillFilter.skills_disabled = true;
  const effectiveSkills = filterSkillsForNode(runCwdSkills, skillFilter);
  const skillsCatalog = renderSkillsCatalog(effectiveSkills);
  return { effectiveEnv, effectiveSkills, skillsCatalog, runProjectCwd };
}

/** Materialise MCP-server tools for the node and merge them into `finalTools`,
 * subject to `denied_tools` / an mcp-only `allowed_tools`. Registers teardown
 * on `disposers`. Returns an early `outcome` when an mcp-only allowlist
 * materialised nothing. A no-connector / no-servers node is a pass-through. */
export async function materializeMcpTools(
  deps: ToolAssemblyDeps,
  args: {
    input: LlmInput;
    finalTools: AnyTool[];
    declaredMcpServers: string[];
    mcpOnlyAllowlist: boolean;
    allow: string[] | undefined;
    runProjectCwd: string;
    disposers: Array<() => Promise<void>>;
  },
): Promise<{ outcome: Outcome } | { finalTools: AnyTool[] }> {
  const { input, declaredMcpServers, mcpOnlyAllowlist, allow, runProjectCwd, disposers } = args;
  let finalTools = args.finalTools;
  if (!deps.mcpConnector || declaredMcpServers.length === 0) return { finalTools };
  const materializeOpts: Parameters<McpConnector["materialize"]>[1] = { cwd: runProjectCwd };
  if (input.signal) materializeOpts.signal = input.signal;
  const toolset = await deps.mcpConnector.materialize(declaredMcpServers, materializeOpts);
  disposers.push(() => toolset.dispose());
  const denied = new Set((input.node.attrs.denied_tools as string[] | undefined)?.map(normalizeMcpToolRef) ?? []);
  const mcpAllow = allow?.filter((a) => isMcpToolName(a)).map(normalizeMcpToolRef);
  const mcpAllowSet = mcpAllow && mcpAllow.length > 0 ? new Set(mcpAllow) : undefined;
  const mcpTools = toolset.tools.filter(
    (t) => !denied.has(t.name) && (mcpAllowSet === undefined || mcpAllowSet.has(t.name)),
  );
  finalTools = [...finalTools, ...mcpTools];
  if (input.emit) {
    for (const e of toolset.errors) {
      // A collision means the server IS live (its other tools materialised) —
      // don't word it as "skipped", which sends operators to debug connectivity.
      const message =
        e.kind === "collision"
          ? `mcp tool from "${e.server}" dropped: ${e.message}`
          : `mcp server "${e.server}" skipped: ${e.message}`;
      await input.emit("agent.warning", { message });
    }
    if (mcpTools.length > 0) {
      await input.emit("agent.info", {
        message: `mcp: ${mcpTools.length} tool(s) from [${declaredMcpServers.join(", ")}]`,
      });
    }
  }
  // Re-check the empty-tools gate now that materialisation has run: an
  // mcp-only allowlist that resolved nothing would run tool-less but
  // "successful" — the silent-empty-tools footgun. Fail loudly instead.
  if (mcpOnlyAllowlist && mcpTools.length === 0) {
    const available = toolset.tools.map((t) => t.name);
    return {
      outcome: fail(
        available.length > 0
          ? `allowed_tools listed only MCP tools ([${allow?.join(", ")}]) but none match the tools materialised from [${declaredMcpServers.join(", ")}] — available: [${available.join(", ")}]. Check the tool names.`
          : `allowed_tools listed only MCP tools ([${allow?.join(", ")}]) but none materialised from mcp-servers [${declaredMcpServers.join(", ")}] — check .mcp.json server credentials and connectivity.`,
        { non_retryable: true },
      ),
    };
  }
  return { finalTools };
}

/** Build the pi-agent tool array from the resolved `finalTools`: attach the
 * per-run fragua context, then append the single terminating exit tool
 * (`route` XOR `emit_output`), then canonicalise order for cache stability. */
export function assembleAgentTools(args: {
  input: LlmInput;
  finalTools: AnyTool[];
  effectiveEnv: ExecutionEnvironment;
  nodeRoutes: string[] | undefined;
  outputsDecl: OutputsDecl | undefined;
  /** Synthesised `agent` tool, present iff the node opted in via
   * `allowed-tools: [agent]`. Appended like `route` / `emit_output` but
   * callable any number of times (not a terminating exit). */
  agentTool?: AgentTool;
}): { tools: AgentTool[]; fraguaContext: FraguaToolContext & { skillCatalog?: readonly Skill[] } } {
  const { input, finalTools, effectiveEnv, nodeRoutes, outputsDecl, agentTool } = args;
  // Per-run fragua context. `skillCatalog` is patched in after the system
  // prompt resolves; tools captured by `toAgentTool` close over this same
  // object reference, so the later patch is visible to every tool call.
  const fraguaEmit = input.emit;
  const fraguaContext: FraguaToolContext & { skillCatalog?: readonly Skill[] } = {
    runId: input.run_id,
    nodeId: input.node.id,
    iteration: input.iteration?.n ?? 0,
    http: makeHttpClient({ signal: input.signal }),
    emit: fraguaEmit
      ? (type, payload) => {
          void fraguaEmit(type as EventType, payload);
        }
      : () => {},
    ...(input.judge !== undefined ? { judge: input.judge } : {}),
  };
  const tools: AgentTool[] = finalTools.map((t) => toAgentTool(t, effectiveEnv, fraguaContext));
  // Exit-tool synthesis — a node exits via exactly ONE terminating tool:
  // routes → the ephemeral per-call `route` enum, outputs → `emit_output`,
  // neither → the loop ends when the agent stops emitting calls. Mutually
  // exclusive (parser-enforced); force-included regardless of allow/deny.
  const hasRoutes = Array.isArray(nodeRoutes) && nodeRoutes.length > 0;
  if (hasRoutes) {
    tools.push(buildRouteTool(nodeRoutes as string[]));
  } else if (outputsDecl !== undefined) {
    tools.push(buildEmitOutputTool(outputsDecl));
  }
  if (agentTool !== undefined) tools.push(agentTool);
  // Canonical tool order: definitions head the provider's prompt-cache prefix,
  // so sorting by name makes the segment a pure function of the effective tool
  // SET regardless of how the tools were assembled.
  tools.sort(byName);
  return { tools, fraguaContext };
}
