import {
  BUNDLE_VERSION,
  type BundleManifest,
  blobPath,
  canonicalJson,
  encodeJsonl,
  MANIFEST_ENTRY,
  runArtifactsPath,
  runEventsPath,
  runMessagesPath,
  runResultPath,
  SCRUBBER_VERSION,
  type TarEntry,
  workflowIrPath,
  workflowSourcePath,
  writeTar,
} from "./bundle.ts";
import { selectUserTableNames } from "./bundle-queries.ts";
import { CURRENT_SCHEMA_VERSION, EVENT_CONTRACT_VERSION } from "./pragmas.ts";
import { collectRoutingBlobShas, isBlobRef } from "./routing-blobs.ts";
import {
  buildExportRegistry,
  extractMcpOAuthLiterals,
  isTextMime,
  scrubEventPayload,
  scrubJsonStrings,
} from "./scrub/export-registry.ts";
import { type ScrubOptions, scrubText } from "./scrub/scrub.ts";
import { sha256Hex } from "./sha256.ts";
import type { StoreCtx } from "./store-ctx.ts";
import type { ExportBundleOptions, ExportBundleResult } from "./types.ts";

/**
 * Walk an exported event payload and rewrite every `$fragua_blob` sha in the
 * genesis routing to the export sha from `reCasMap`. Called after
 * `scrubEventPayload` so free-text string values are already scrubbed; only
 * the ref object's sha field needs to change. Returns the original when there
 * is nothing to rewrite (no allocation on the hot path for non-genesis events).
 */
function rewriteRoutingRefs(
  payload: unknown,
  reCasMap: Map<string, { exportSha: string; exportBytes: Uint8Array }>,
): unknown {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const src = payload as Record<string, unknown>;
  const routing = src["routing"];
  if (routing == null || typeof routing !== "object" || Array.isArray(routing)) return payload;
  const newRouting = deepRewriteRefs(routing, reCasMap);
  if (newRouting === routing) return payload;
  return { ...src, routing: newRouting };
}

function deepRewriteRefs(v: unknown, reCasMap: Map<string, { exportSha: string; exportBytes: Uint8Array }>): unknown {
  if (isBlobRef(v)) {
    const origSha = v["$fragua_blob"];
    const mapped = reCasMap.get(origSha);
    if (mapped == null || mapped.exportSha === origSha) return v;
    return { ...v, $fragua_blob: mapped.exportSha };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((item) => {
      const r = deepRewriteRefs(item, reCasMap);
      if (r !== item) changed = true;
      return r;
    });
    return changed ? out : v;
  }
  if (v !== null && typeof v === "object") {
    const src = v as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(src)) {
      const r = deepRewriteRefs(val, reCasMap);
      if (r !== val) changed = true;
      out[k] = r;
    }
    return changed ? out : v;
  }
  return v;
}

/** Event types dropped from bundle exports — streaming deltas and scaffolding
 * that are losslessly reconstructable from the `messages` transcript.
 * Everything NOT in this set is retained so read-plane projections work on
 * imported runs. See docs/proposals/secret-scrubbing.md §4 for the rationale.
 *
 * Tier-3 decision: retain llm.error, budget.warn, budget.stop, steering.*,
 * control.*, and legacy run.* lifecycle echoes (small structural payloads
 * useful for forensics, already covered by scrubEventPayload for free-text
 * fields). Drop snapshot.captured (snapshot refs aren’t in the bundle and
 * imported cwd=null means no diff target anyway). */
const EXPORT_DENYLIST = new Set<string>([
  "llm.text_delta",
  "llm.text_end",
  "llm.thinking_delta",
  "llm.thinking_end",
  "llm.toolcall_delta",
  "llm.toolcall_end",
  "agent.start",
  "agent.end",
  "agent.message_start",
  "agent.message_end",
  "agent.message_update",
  "agent.turn_start",
  "agent.turn_end",
  "tool.execution_start",
  "tool.execution_update",
  "tool.execution_end",
  "tool.output_chunk",
  "summary.started",
  "summary.text_delta",
  "snapshot.captured",
]);

/** Slim an `llm.start` payload for bundle export: keep identity and manifest
 * fields that back read-plane projections (getStepAggregates, eventsToSteps),
 * strip the free-text `prompt` which is already in the `messages` transcript
 * and is a secret-leak surface.
 *
 * Mirrors the identity-field set of `truncationMarker` and extends it with
 * the small manifests carried by llm.start. `system_prompt` on llm.start is
 * already a `{ sha256, bytes }` digest (not full text) and passes through. */
function slimLlmStartForExport(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return out;
  const src = payload as Record<string, unknown>;
  if (typeof src["nodeId"] === "string") out["nodeId"] = src["nodeId"];
  if (typeof src["provider"] === "string") out["provider"] = src["provider"];
  if (typeof src["model"] === "string") out["model"] = src["model"];
  if (typeof src["thread_id"] === "string") out["thread_id"] = src["thread_id"];
  if (typeof src["summary"] === "string") out["summary"] = src["summary"];
  if (typeof src["iteration"] === "number") {
    out["iteration"] = src["iteration"];
  } else if (src["iteration"] != null && typeof src["iteration"] === "object") {
    const it = src["iteration"] as Record<string, unknown>;
    if (typeof it["n"] === "number" && typeof it["max"] === "number") {
      out["iteration"] = { n: it["n"], max: it["max"] };
    }
  }
  if (src["context_files"] !== undefined) out["context_files"] = src["context_files"];
  if (src["skills"] !== undefined) out["skills"] = src["skills"];
  if (src["budget"] !== undefined) out["budget"] = src["budget"];
  if (src["system_prompt"] !== undefined) out["system_prompt"] = src["system_prompt"];
  return out;
}

/** Prune the store to the portable, replayable run record, dropping every
 * other table — the secret-bearing (`provider_credentials`, `provider_config`,
 * `mcp_oauth`)
 * and instance-scoped (`daemon_lock`, `server_endpoint`, `daemon_events`,
 * `schedules`) ones — then VACUUM + checkpoint so the dropped bytes are truly
 * gone (no freelist or WAL residue). `fragua ci` calls this before leaving a
 * `--db` artifact, so the pruned store carries no credential TABLE.
 *
 * NOT a scrub: the retained `events`/`messages` keep the RAW transcript +
 * observability deltas, which can hold secret values verbatim. The pruned
 * `--db` store is a raw inspection record, NOT secret-free — the scrubbed,
 * safe-to-publish artifact is `exportRunBundle` (the `.fragua` bundle).
 *
 * An ALLOWLIST, not a denylist: a table is dropped unless it's explicitly
 * part of the portable record, so a future table can't silently ride along.
 * Keep this in sync with schema.sql. */
export function retainPortableTables(ctx: StoreCtx): void {
  // `imported_runs` rides along: it's the authoritative inert marker, and
  // `getState` reads it to derive `imported`. Dropping it would both break that
  // read and strip the inert flag from any imported run in a portable copy.
  const portable = new Set([
    "schema_version",
    "workflows",
    "run_state",
    "events",
    "messages",
    "artifacts",
    "blobs",
    "imported_runs",
  ]);
  const tables = selectUserTableNames(ctx.db);
  ctx.db.exec("PRAGMA foreign_keys = OFF");
  for (const t of tables) {
    if (!portable.has(t)) ctx.db.exec(`DROP TABLE IF EXISTS "${t}"`);
  }
  ctx.db.exec("PRAGMA foreign_keys = ON");
  ctx.db.exec("VACUUM");
  ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/** Export `runId` as a portable `.fragua` bundle (bundles.md): a
 * manifest-first tar carrying a DENYLIST-FILTERED EVENT LOG, transcript,
 * artifact rows, the content-addressed workflow, and the referenced blob
 * bytes. There is NO `run_state` — it is re-derived on import by replaying
 * the log.
 *
 * Event filtering (denylist): streaming-delta and scaffolding events that are
 * losslessly reconstructable from the `messages` transcript are dropped.
 * Everything else is retained so read-plane projections (step aggregates,
 * edge overlays, title) work on imported runs. Dropped types:
 *   llm.text_delta, llm.text_end, llm.thinking_delta, llm.thinking_end,
 *   llm.toolcall_delta, llm.toolcall_end,
 *   agent.start, agent.end, agent.message_start, agent.message_end,
 *   agent.message_update, agent.turn_start, agent.turn_end,
 *   tool.execution_start, tool.execution_update, tool.execution_end,
 *   tool.output_chunk, summary.started, summary.text_delta,
 *   snapshot.captured (snapshot refs not in bundle; imported cwd=null).
 * Retained: llm.start (slimmed — prompt stripped, identity fields kept),
 *   llm.done, llm.error, edge.selected, run.title_generated, cost.recorded,
 *   budget.warn, budget.stop, steering.*, control.*, fact.*, intent.*.
 *
 * `llm.start` is exported as a slimmed payload (prompt stripped; see
 * `slimLlmStartForExport`) so it anchors getStepAggregates cost windows
 * and eventsToSteps LLM-step detection without leaking prompt text.
 *
 * Stored events are never mutated — filtering and slimming are export-only.
 * Message content and event payload free-text fields are scrubbed at export
 * time (literal credentials + cwd path + known-format patterns). To build the
 * literal needle set this reads `provider_credentials` payloads into the
 * registry in memory for the duration of the call — cleartext secrets never
 * enter the bundle, but the egress path does touch them. Text-ish
 * artifact blobs (mime `text/*` or `application/json|x-yaml|xml|javascript`)
 * are decoded, scrubbed, and re-CASed — the new sha replaces the original in
 * the artifacts JSONL, blob tar entry, and manifest blobs[] consistently.
 * Binary blobs ship as-is under their original sha; a secret in a binary
 * artifact is a known residual (see docs/proposals/secret-scrubbing.md §13).
 *
 * `fraguaVersion` is stamped for the import-time compatibility check.
 * Single-run today (the `fragua ci --export` producer); the format is
 * multi-run by construction. Rows are canonically ordered (events by seq,
 * messages by ordinal, artifacts/blobs by sha) for re-export determinism. */
export function exportRunBundle(ctx: StoreCtx, runId: string, opts: ExportBundleOptions): ExportBundleResult {
  const run = ctx.store.getState(runId);
  if (run == null) throw new Error(`exportRunBundle: run not found: ${runId}`);
  const wf = ctx.store.getWorkflow(run.workflowSha);
  if (wf == null) throw new Error(`exportRunBundle: workflow ${run.workflowSha} missing for run ${runId}`);

  const allEvents = [...ctx.store.getEvents(runId)].sort((a, b) => a.seq - b.seq);
  const events = allEvents.filter((e) => !EXPORT_DENYLIST.has(e.type));
  const messages = [...ctx.store.getMessages(runId)].sort((a, b) => a.ordinal - b.ordinal);

  // mcp_oauth tokens + client_secret are secret-bearing like provider creds and
  // must be redacted from the bundle if they appear verbatim anywhere.
  const mcpOAuthLiterals = ctx.store
    .listMcpOAuth()
    .flatMap((r) => extractMcpOAuthLiterals(r.payload).map((value) => ({ value, source: "mcp_oauth" })));
  const extraLiterals = [...mcpOAuthLiterals, ...(opts.extraLiterals ?? [])];
  const { registry, literalValues } = buildExportRegistry({
    providerCredentials: ctx.store.listProviderCredentials(),
    cwd: run.cwd,
    ...(extraLiterals.length > 0 ? { extraLiterals } : {}),
  });
  const artifacts = ctx.store
    .listArtifacts(runId)
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.iteration - b.iteration || a.key.localeCompare(b.key));

  // Text surfaces are always scrubbed; the live-literal gate fires only on
  // binary artifacts (the §13 residual — shipped as-is). The scrub pass itself
  // never needs a callback: hits in text mean the secret was REDACTED = safe.
  let liveLiteralHit = false;
  const scrubOpts: ScrubOptions = {
    labels: opts.labelMode ?? "source",
  };

  // Re-CAS map: original blobSha → exported sha (may differ for text blobs).
  // Built before assembling the tar so artifact rows and blob entries are
  // consistent in all three places (artifacts JSONL, blob tar entry, manifest).
  // Routing blobs are seeded FIRST so they share the map with artifact blobs
  // and deduplicate consistently (a routing blob and an artifact blob with the
  // same content produce one tar entry, one manifest row, one mapping entry).
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const reCasMap = new Map<string, { exportSha: string; exportBytes: Uint8Array }>();

  // Seed routing blobs: spilled routing.inputs values are always text.
  // Scrub via scrubText (single string, not nested JSON) and re-CAS.
  // ASSUMPTION: only `intent.run_enqueued` carries routing blob refs.
  // Routing is set once at enqueue and never mutated by any subsequent intent;
  // if a future intent ever mutates routing.inputs this loop must enumerate
  // every such event, not just the genesis.
  const genesisEvent = events.find((e) => e.type === "intent.run_enqueued");
  if (genesisEvent != null) {
    const gp = genesisEvent.payload as Record<string, unknown>;
    const routingForBlobs = gp["routing"] as Record<string, unknown> | undefined;
    if (routingForBlobs != null) {
      for (const origSha of collectRoutingBlobShas(routingForBlobs)) {
        if (reCasMap.has(origSha)) continue;
        const origBytes = ctx.blobs.get(origSha);
        const text = dec.decode(origBytes);
        const scrubbed = scrubText(text, registry, scrubOpts);
        const exportBytes = scrubbed !== text ? enc.encode(scrubbed) : origBytes;
        const exportSha = scrubbed !== text ? sha256Hex(exportBytes) : origSha;
        reCasMap.set(origSha, { exportSha, exportBytes });
      }
    }
  }

  for (const artifact of artifacts) {
    const origSha = artifact.blobSha;
    if (reCasMap.has(origSha)) continue;
    const origBytes = ctx.blobs.get(origSha);
    if (isTextMime(artifact.mime)) {
      const text = dec.decode(origBytes);
      let scrubbed: string;
      const mimeBase = (artifact.mime ?? "").split(";")[0]!.trim();
      if (mimeBase === "application/json") {
        try {
          const parsed: unknown = JSON.parse(text);
          const scrubbedObj = scrubJsonStrings(parsed, registry, scrubOpts);
          scrubbed = JSON.stringify(scrubbedObj);
        } catch {
          scrubbed = scrubJsonStrings(text, registry, scrubOpts) as string;
        }
      } else {
        scrubbed = scrubJsonStrings(text, registry, scrubOpts) as string;
      }
      const exportBytes = scrubbed !== text ? enc.encode(scrubbed) : origBytes;
      const exportSha = scrubbed !== text ? sha256Hex(exportBytes) : origSha;
      reCasMap.set(origSha, { exportSha, exportBytes });
    } else {
      // Binary blobs ship as-is — scanned below for verbatim live-literal hits
      // (the §13 residual gate). A hit sets liveLiteralHit; the blob is still
      // exported unchanged (we scan-and-alarm, not redact-in-place).
      reCasMap.set(origSha, { exportSha: origSha, exportBytes: origBytes });
    }
  }

  // Spilled structured-output blobs: a `fact.node_completed` whose `outputs`
  // is a `$fragua_blob` ref points at a CAS blob holding the struct JSON.
  // Collect, scrub as JSON, and re-CAS (same treatment as a text artifact) so
  // the blob ships in the bundle; the event ref is rewritten to the export
  // sha at serialisation below.
  for (const e of events) {
    if (e.type !== "fact.node_completed") continue;
    const out = (e.payload as { outputs?: unknown }).outputs;
    if (!isBlobRef(out)) continue;
    const origSha = out.$fragua_blob;
    if (reCasMap.has(origSha)) continue;
    const origBytes = ctx.blobs.get(origSha);
    const text = dec.decode(origBytes);
    let scrubbed: string;
    try {
      scrubbed = JSON.stringify(scrubJsonStrings(JSON.parse(text), registry, scrubOpts));
    } catch {
      scrubbed = scrubJsonStrings(text, registry, scrubOpts) as string;
    }
    const exportBytes = scrubbed !== text ? enc.encode(scrubbed) : origBytes;
    const exportSha = scrubbed !== text ? sha256Hex(exportBytes) : origSha;
    reCasMap.set(origSha, { exportSha, exportBytes });
  }

  // Binary-artifact residual gate: scan every binary blob for verbatim
  // live-literal values. Text blobs are always scrubbed, so only binary ones
  // can contain a live secret. A single hit flips liveLiteralHit=true — the
  // blob is still exported unchanged (scan-and-alarm, not redact-in-place).
  if (literalValues.length > 0) {
    for (const artifact of artifacts) {
      if (isTextMime(artifact.mime)) continue;
      const entry = reCasMap.get(artifact.blobSha);
      if (entry == null) continue;
      const buf = Buffer.isBuffer(entry.exportBytes)
        ? entry.exportBytes
        : Buffer.from(entry.exportBytes.buffer, entry.exportBytes.byteOffset, entry.exportBytes.byteLength);
      for (const literal of literalValues) {
        if (buf.includes(literal)) {
          liveLiteralHit = true;
          break;
        }
      }
      if (liveLiteralHit) break;
    }
  }

  // Collect unique export shas (deduped CAS — two artifacts that scrub to the
  // same bytes share one blob entry). Build a sha → entry map in one pass to
  // avoid the O(n²) .find() per sha.
  const exportShaMap = new Map<string, { exportSha: string; exportBytes: Uint8Array }>();
  for (const entry of reCasMap.values()) {
    if (!exportShaMap.has(entry.exportSha)) exportShaMap.set(entry.exportSha, entry);
  }
  const exportShas = [...exportShaMap.keys()].sort();
  const blobEntries: TarEntry[] = [];
  const blobManifest: { sha256: string; size: number }[] = [];
  for (const exportSha of exportShas) {
    const entry = exportShaMap.get(exportSha)!;
    blobEntries.push({ name: blobPath(exportSha), data: entry.exportBytes });
    blobManifest.push({ sha256: exportSha, size: entry.exportBytes.length });
  }

  const manifest: BundleManifest = {
    bundleVersion: BUNDLE_VERSION,
    scrubberVersion: SCRUBBER_VERSION,
    fraguaVersion: opts.fraguaVersion,
    contractVersion: EVENT_CONTRACT_VERSION,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    irVersion: wf.irVersion,
    runs: [{ runId, workflowSha: run.workflowSha, events: events.length, messages: messages.length }],
    workflows: [{ sha: wf.sha, name: wf.name, irVersion: wf.irVersion }],
    blobs: blobManifest,
  };

  const bytes = writeTar([
    { name: MANIFEST_ENTRY, data: new TextEncoder().encode(canonicalJson(manifest)) },
    {
      name: runEventsPath(runId),
      data: encodeJsonl(
        events.map((e) => {
          // Slim llm.start before scrub so prompt is stripped first, then
          // the retained identity fields still go through the registry.
          const exportPayloadPre = e.type === "llm.start" ? slimLlmStartForExport(e.payload) : e.payload;
          const scrubbedPayload = scrubEventPayload(e.type, exportPayloadPre, registry, scrubOpts);
          // Rewrite $fragua_blob shas in the genesis routing so the exported
          // ref points at the scrubbed blob's new sha. scrubEventPayload leaves
          // ref objects (non-string values) untouched — only the sha needs
          // updating to match what we put in the tar and manifest.
          const exportPayload =
            e.type === "intent.run_enqueued"
              ? rewriteRoutingRefs(scrubbedPayload, reCasMap)
              : e.type === "fact.node_completed"
                ? (deepRewriteRefs(scrubbedPayload, reCasMap) as typeof scrubbedPayload)
                : scrubbedPayload;
          return { seq: e.seq, type: e.type, writer: e.writer, payload: exportPayload, ts: e.ts };
        }),
      ),
    },
    {
      name: runMessagesPath(runId),
      data: encodeJsonl(
        messages.map((m) => ({
          ordinal: m.ordinal,
          content: scrubJsonStrings(m.content, registry, scrubOpts),
          nodeId: m.nodeId,
          iteration: m.iteration,
          pass: m.pass,
        })),
      ),
    },
    {
      name: runArtifactsPath(runId),
      data: encodeJsonl(
        artifacts.map((a) => ({
          ...a,
          blobSha: reCasMap.get(a.blobSha)?.exportSha ?? a.blobSha,
        })),
      ),
    },
    ...(opts.runResult !== undefined
      ? [
          {
            name: runResultPath(runId),
            data: enc.encode(JSON.stringify(scrubJsonStrings(opts.runResult, registry, scrubOpts))),
          },
        ]
      : []),
    { name: workflowSourcePath(wf.sha), data: new TextEncoder().encode(wf.source) },
    { name: workflowIrPath(wf.sha), data: new TextEncoder().encode(wf.ir) },
    ...blobEntries,
  ]);
  return { bytes, liveLiteralHit };
}
