import { readRawInputs, validateRoutingPatch } from "@fragua/core";
import type { RunEnqueuedPayload } from "@fragua/types";
import {
  blobRowExists,
  deleteOrphanBlobs,
  insertBlobIfAbsent,
  selectBlobRootShas,
  selectDeletableOrphanFiles,
  upsertArtifact,
} from "./artifact-queries.ts";
import { insertEventDaemon, insertEventRunEnqueued, insertEventWeb } from "./event-queries.ts";
import { insertMessage, selectMaxMessageOrdinal, selectMessageByDedup } from "./message-queries.ts";
import { insertOutput } from "./outputs-queries.ts";
import { EVENT_CONTRACT_VERSION } from "./pragmas.ts";
import { applyFact, crashRequeueActiveMsDelta, emptyMetrics } from "./reducers.ts";
import { maybeSpillStruct, spillRoutingInputs } from "./routing-blobs.ts";
import {
  bumpRunSeq,
  claimQueuedRun,
  countDispatchableRunningRuns,
  insertRunState,
  selectCheckoutHolder,
  selectNextQueuedRun,
  selectRunStateRow,
  updateRunStateTitle,
  writeRunStateProjection,
} from "./run-state-queries.ts";
import { sha256Hex } from "./sha256.ts";
import type { StoreCtx } from "./store-ctx.ts";
import { rowToRunState } from "./store-rows.ts";
import { appendCrashRequeue, startupSweep as runStartupSweep } from "./sweep.ts";
import {
  type AppendFactOpts,
  ArtifactCollisionError,
  type ArtifactRef,
  type ArtifactScope,
  ArtifactTooLargeError,
  CheckoutBusyError,
  ClaimLostError,
  ConcurrencyError,
  type EnqueueRunParams,
  type FactAppendResult,
  type FactEvent,
  type IntentAppendResult,
  type IntentEvent,
  MAX_BLOB_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_ROUTING_BYTES,
  type Message,
  MessageTooLargeError,
  type ObservabilityEvent,
  PayloadTooLargeError,
  RunNotFoundError,
  type RunState,
  type SweepResult,
  utf8ByteLength,
} from "./types.ts";
import { insertWorkflowIfAbsent, workflowExists } from "./workflow-queries.ts";

/**
 * Apply the in-memory projection to `run_state`. Runs under the write lock
 * (it is only ever called from inside a `writeTxn`), so it MUST NOT serialize
 * (invariant I1): the caller pre-serializes `routing`/`metrics`/`changeStat`
 * and runs the MAX_ROUTING_BYTES guard before opening the transaction.
 */
export function writeProjection(
  ctx: StoreCtx,
  state: RunState,
  expectedVersion: number,
  serialized: { routingJson: string; metricsJson: string; changeStatJson: string | null },
  epochBump = 0,
): void {
  const applied = writeRunStateProjection(ctx.db, {
    runId: state.runId,
    version: state.version,
    expectedVersion,
    status: state.status,
    currentNode: state.currentNode,
    routingJson: serialized.routingJson,
    metricsJson: serialized.metricsJson,
    lastAppliedSeq: state.lastAppliedSeq,
    priority: state.priority,
    readyAt: state.readyAt,
    nodeStartedAt: state.nodeStartedAt,
    dispatchStartedAt: state.dispatchStartedAt,
    updatedAt: state.updatedAt,
    baseGitSha: state.baseGitSha,
    baseGitRef: state.baseGitRef,
    baseHeadSha: state.baseHeadSha,
    checkoutReleased: state.checkoutReleased,
    finalGitSha: state.finalGitSha,
    finalHeadRef: state.finalHeadRef,
    diffBaseSha: state.diffBaseSha,
    changeStatJson: serialized.changeStatJson,
    inboxStatus: state.inboxStatus,
    acceptedSha: state.acceptedSha,
    epochBump,
  });
  if (!applied) {
    const row = selectRunStateRow(ctx.db, state.runId);
    throw new ConcurrencyError(expectedVersion, row?.version ?? -1);
  }
}

/** Replacement payload for an oversized observability event. Preserves
 * the small, high-value metadata fields UIs / aggregators rely on (node
 * routing, model identity, iteration loop position, thread context) and
 * stamps an explicit truncation marker so consumers don't silently read
 * fabricated data. The bulky parts (prompt, system_prompt, messages,
 * skills, context_files) are reconstructable from the `messages` table
 * + the workflow source and are deliberately dropped here.
 *
 * Anything added here must stay *short*: the whole truncated payload
 * still has to fit in MAX_EVENT_PAYLOAD_BYTES, which is the reason we
 * truncate in the first place. Strings + numbers + the small
 * `iteration` object only — no nested arrays. */
function truncationMarker(original: unknown, originalBytes: number): Record<string, unknown> {
  const out: Record<string, unknown> = { _truncated: true, _original_bytes: originalBytes };
  if (original != null && typeof original === "object") {
    const src = original as Record<string, unknown>;
    if (typeof src["nodeId"] === "string") out["nodeId"] = src["nodeId"];
    // `iteration` is overloaded across event types: a plain number on
    // observability events stamped by the executor, a `{ n, max }`
    // object on llm.start when the caller is a loop. Keep both shapes.
    if (typeof src["iteration"] === "number") {
      out["iteration"] = src["iteration"];
    } else if (src["iteration"] != null && typeof src["iteration"] === "object") {
      const it = src["iteration"] as Record<string, unknown>;
      if (typeof it["n"] === "number" && typeof it["max"] === "number") {
        out["iteration"] = { n: it["n"], max: it["max"] };
      }
    }
    if (typeof src["content_index"] === "number") out["content_index"] = src["content_index"];
    // llm.start-specific identity fields — without these the step UI
    // can't render the model name, look up the context window, or join
    // back to the right thread when the prompt + system_prompt push
    // the payload over the cap. All four are short strings.
    if (typeof src["provider"] === "string") out["provider"] = src["provider"];
    if (typeof src["model"] === "string") out["model"] = src["model"];
    if (typeof src["thread_id"] === "string") out["thread_id"] = src["thread_id"];
    if (typeof src["summary"] === "string") out["summary"] = src["summary"];
  }
  return out;
}

export function appendFact(
  ctx: StoreCtx,
  runId: string,
  events: FactEvent[],
  expectedVersion: number,
  opts: AppendFactOpts = {},
): FactAppendResult {
  if (events.length === 0) {
    throw new Error("appendFact requires at least one event");
  }
  // Gate the routing patch against the known key vocabulary BEFORE the write
  // transaction opens (I1): an unknown key family or wrong-typed value must be
  // rejected here, never spread into the projection where a later typed read
  // would silently degrade to a conservative default and a wrong dispatch.
  if (opts.routingPatch != null) validateRoutingPatch(opts.routingPatch);
  const ts = ctx.now();
  const seqs: number[] = [];
  let newVersion = 0;
  let committedState: RunState | undefined;
  const startAt = performance.now();

  // Pre-serialise outputs payloads OUTSIDE the transaction (invariant I1:
  // no JSON.stringify inside db.transaction). We extract them from the
  // node_completed events before entering the txn so insertOutput receives a
  // plain string inside the closure. An oversized struct spills to the blob
  // CAS here (blob written before the txn, same crash-safety as routing
  // spill): the event payload + the index then hold a tiny `{$fragua_blob}`
  // ref, so neither needs raising past the 4 KiB cap, and a large struct is
  // no longer a node failure.
  const outputsInserts: Array<{ nodeId: string; iteration: number; structJson: string }> = [];
  const outputsSpilledBlobs: Array<{ sha: string; bytes: number }> = [];
  const outputsSpilledData: Array<{ sha: string; data: Uint8Array }> = [];
  for (const event of events) {
    if (event.type === "fact.node_completed") {
      const p = event.payload as { nodeId: string; iteration: number; outputs?: Record<string, unknown> };
      if (p.outputs !== undefined) {
        const structJson = JSON.stringify(p.outputs);
        const ref = maybeSpillStruct(structJson, (sha, bytes) => {
          ctx.blobs.put(sha, bytes);
          outputsSpilledData.push({ sha, data: bytes });
        });
        if (ref !== null) {
          // Replace the inline struct in the event payload with the ref so the
          // event stays under the 4 KiB cap; the index stores the same ref.
          p.outputs = { ...ref };
          outputsInserts.push({ nodeId: p.nodeId, iteration: p.iteration, structJson: JSON.stringify(ref) });
          outputsSpilledBlobs.push({ sha: ref.$fragua_blob, bytes: ref.bytes });
        } else {
          outputsInserts.push({ nodeId: p.nodeId, iteration: p.iteration, structJson });
        }
      }
    }
  }

  try {
    // Fold + serialize OUTSIDE the write lock (invariant I1: no JSON.stringify
    // inside a txn body). We read the row optimistically, fold the events, and
    // serialize the resulting projection here; the txn below re-checks the
    // version under the lock and writeProjection's expectedVersion guard rejects
    // a stale write, so the speculative fold stays OCC-correct.
    const row = selectRunStateRow(ctx.db, runId);
    if (row == null) throw new Error(`unknown run ${runId}`);
    if (opts.claimEpoch !== undefined && row.claim_epoch !== opts.claimEpoch) {
      throw new ClaimLostError(opts.claimEpoch, row.claim_epoch, expectedVersion, row.version);
    }
    if (row.version !== expectedVersion) {
      throw new ConcurrencyError(expectedVersion, row.version);
    }

    let state = rowToRunState(row);
    for (const event of events) {
      state = applyFact(state, event, ts);
    }
    if (opts.routingPatch != null) {
      state = { ...state, routing: { ...state.routing, ...opts.routingPatch } };
    }
    state = {
      ...state,
      version: state.version + 1,
      lastAppliedSeq: opts.advanceAppliedTo != null ? opts.advanceAppliedTo : state.lastAppliedSeq,
    };

    // Pre-serialize the projection + event payloads, and run the MAX_ROUTING_BYTES
    // guard here so an oversized routing payload fails closed before the lock.
    const routingJson = JSON.stringify(state.routing);
    const routingBytes = utf8ByteLength(routingJson);
    if (routingBytes >= MAX_ROUTING_BYTES) {
      throw new PayloadTooLargeError(routingBytes, MAX_ROUTING_BYTES);
    }
    const projection = {
      routingJson,
      metricsJson: JSON.stringify(state.metrics),
      changeStatJson: state.changeStat != null ? JSON.stringify(state.changeStat) : null,
    };
    const eventPayloads = events.map((event) => ctx.validatePayload(event.payload));
    const epochBump = events.some((event) => event.type === "fact.run_requeued_after_crash") ? 1 : 0;
    committedState = state;
    newVersion = state.version;

    ctx.writeTxn(() => {
      // Re-check the version under the lock: the fold above ran on a snapshot
      // read taken before the txn, so another writer may have advanced the row.
      const current = selectRunStateRow(ctx.db, runId);
      if (current == null) throw new Error(`unknown run ${runId}`);
      if (opts.claimEpoch !== undefined && current.claim_epoch !== opts.claimEpoch) {
        throw new ClaimLostError(opts.claimEpoch, current.claim_epoch, expectedVersion, current.version);
      }
      if (current.version !== expectedVersion) {
        throw new ConcurrencyError(expectedVersion, current.version);
      }

      for (let i = 0; i < events.length; i++) {
        const seq = bumpRunSeq(ctx.db, runId);
        seqs.push(seq);
        insertEventDaemon(ctx.db, runId, seq, events[i]!.type, eventPayloads[i]!, ts);
      }

      // Durability barrier for spilled-output blobs: the BlobFS.put() ran
      // before this txn; the row insert makes them reachable + GC-protected.
      for (const { sha, bytes } of outputsSpilledBlobs) {
        insertBlobIfAbsent(ctx.db, sha, bytes, ts);
      }

      // Write outputs index rows in the same transaction (ground rule #5).
      for (const o of outputsInserts) {
        insertOutput(ctx.db, runId, o.nodeId, o.iteration, o.structJson);
      }

      writeProjection(ctx, state, expectedVersion, projection, epochBump);
    });
    ctx.metrics.recordWrite(performance.now() - startAt, "fact");
  } catch (err) {
    if (err instanceof ConcurrencyError) ctx.metrics.recordOccConflict();
    throw err;
  }
  reputBlobs(ctx, outputsSpilledData);

  return { committed: true, newVersion, seqs, ...(committedState !== undefined ? { state: committedState } : {}) };
}

export function appendIntent(ctx: StoreCtx, runId: string, event: IntentEvent): IntentAppendResult {
  const payload = ctx.validatePayload(event.payload);
  const ts = ctx.now();
  let seq = 0;
  const startAt = performance.now();

  ctx.writeTxn(() => {
    const row = selectRunStateRow(ctx.db, runId);
    if (row == null) throw new RunNotFoundError(runId);
    seq = bumpRunSeq(ctx.db, runId);
    insertEventWeb(ctx.db, runId, seq, event.type, payload, ts);
  });
  ctx.metrics.recordWrite(performance.now() - startAt, "intent");

  return { seq, ts };
}

export function appendIntentWithFact(
  ctx: StoreCtx,
  runId: string,
  intent: IntentEvent,
  facts: FactEvent[],
  expectedVersion: number,
): { intentSeq: number; factSeqs: number[]; newVersion: number } {
  if (facts.length === 0) throw new Error("appendIntentWithFact requires at least one fact");
  const ts = ctx.now();
  const startAt = performance.now();
  // Fold + serialize outside the lock (I1); the txn re-checks version and
  // next_seq so the predicted intent seq and the speculative fold stay valid.
  const row = selectRunStateRow(ctx.db, runId);
  if (row == null) throw new RunNotFoundError(runId);
  if (row.version !== expectedVersion) throw new ConcurrencyError(expectedVersion, row.version);
  const intentSeq = row.next_seq;
  let state = rowToRunState(row);
  for (const f of facts) state = applyFact(state, f, ts);
  state = { ...state, version: state.version + 1, lastAppliedSeq: Math.max(state.lastAppliedSeq, intentSeq) };
  const projection = {
    routingJson: JSON.stringify(state.routing),
    metricsJson: JSON.stringify(state.metrics),
    changeStatJson: state.changeStat != null ? JSON.stringify(state.changeStat) : null,
  };
  const intentPayload = ctx.validatePayload(intent.payload);
  const factPayloads = facts.map((f) => ctx.validatePayload(f.payload));
  const factSeqs: number[] = [];

  try {
    ctx.writeTxn(() => {
      const current = selectRunStateRow(ctx.db, runId);
      if (current == null) throw new RunNotFoundError(runId);
      if (current.version !== expectedVersion || current.next_seq !== intentSeq) {
        throw new ConcurrencyError(expectedVersion, current.version);
      }
      insertEventWeb(ctx.db, runId, bumpRunSeq(ctx.db, runId), intent.type, intentPayload, ts);
      for (let i = 0; i < facts.length; i++) {
        const seq = bumpRunSeq(ctx.db, runId);
        factSeqs.push(seq);
        insertEventDaemon(ctx.db, runId, seq, facts[i]!.type, factPayloads[i]!, ts);
      }
      writeProjection(ctx, state, expectedVersion, projection);
    });
    ctx.metrics.recordWrite(performance.now() - startAt, "fact");
  } catch (err) {
    if (err instanceof ConcurrencyError) ctx.metrics.recordOccConflict();
    throw err;
  }
  return { intentSeq, factSeqs, newVersion: state.version };
}

export function appendObservabilityEvents(
  ctx: StoreCtx,
  runId: string,
  events: ObservabilityEvent[],
): { seqs: number[] } {
  if (events.length === 0) return { seqs: [] };
  const ts = ctx.now();
  const seqs: number[] = [];
  const startAt = performance.now();

  const truncated: { type: string; bytes: number }[] = [];
  // Serialize + size-check (and, for an oversized event, build the truncation
  // marker) BEFORE the transaction opens — the txn body must not serialize
  // JSON under the write lock (I1). One oversized event must not tank the rest
  // of the batch: swap its payload for a truncation marker that keeps routing
  // info (nodeId, iteration) so UI step-grouping still works. Full content for
  // llm turns is already in the `messages` table.
  const prepared: { type: string; payload: string }[] = [];
  for (const event of events) {
    if (typeof event.type !== "string" || event.type.length === 0) {
      throw new Error("observability event.type must be a non-empty string");
    }
    let payload: string;
    try {
      payload = ctx.validatePayload(event.payload);
    } catch (err) {
      if (!(err instanceof PayloadTooLargeError)) throw err;
      truncated.push({ type: event.type, bytes: err.sizeBytes });
      payload = ctx.validatePayload(truncationMarker(event.payload, err.sizeBytes));
    }
    prepared.push({ type: event.type, payload });
  }
  ctx.writeTxn(() => {
    const row = selectRunStateRow(ctx.db, runId);
    if (row == null) throw new Error(`unknown run ${runId}`);
    for (const p of prepared) {
      const seq = bumpRunSeq(ctx.db, runId);
      seqs.push(seq);
      insertEventDaemon(ctx.db, runId, seq, p.type, p.payload, ts);
    }
  });
  if (truncated.length > 0) {
    for (const t of truncated) {
      // eslint-disable-next-line no-console
      console.warn(
        `[store] truncated oversized observability event for run ${runId}: type=${t.type} bytes=${t.bytes} cap=${MAX_EVENT_PAYLOAD_BYTES}`,
      );
    }
  }
  ctx.metrics.recordWrite(performance.now() - startAt, "fact");

  return { seqs };
}

export function enqueueRun(ctx: StoreCtx, params: EnqueueRunParams): void {
  const now = ctx.now();

  // Spill oversized routing.inputs string values to the blob CAS before
  // the size checks. Blobs are written before the transaction so
  // crash-between-put-and-row leaves an orphan file (GC sweeps it), which
  // is safer than the inverse. The rows are inserted inside writeTxn below.
  let effectiveRouting = params.initialRouting ?? {};
  let spilledBlobs: Array<{ key: string; sha: string; bytes: number }> = [];
  const spilledData: Array<{ sha: string; data: Uint8Array }> = [];
  if (readRawInputs(effectiveRouting) !== undefined) {
    const result = spillRoutingInputs(effectiveRouting, (sha, bytes) => {
      ctx.blobs.put(sha, bytes);
      spilledData.push({ sha, data: bytes });
    });
    effectiveRouting = result.routing;
    spilledBlobs = result.spilled;
  }

  const routing = JSON.stringify(effectiveRouting);
  const routingBytes = utf8ByteLength(routing);
  if (routingBytes >= MAX_ROUTING_BYTES) {
    throw new PayloadTooLargeError(routingBytes, MAX_ROUTING_BYTES);
  }
  const metrics = JSON.stringify(emptyMetrics());

  // project_id / project_name are NOT NULL identity columns. Production
  // callers (CLI run, server enqueue, schedule dispatcher) resolve a real
  // committed id + label at the boundary and pass them explicitly. When a
  // caller omits them (headless/test enqueues), fall back to the cwd as a
  // stable per-store identity and its basename as the label — never NULL.
  const cwd = params.cwd ?? null;
  const projectId = params.projectId ?? cwd ?? "local";
  const projectName =
    params.projectName ?? (cwd != null ? (cwd.split("/").filter(Boolean).at(-1) ?? "local") : "local");

  // The genesis event carries the whole enqueue identity so `run_state` is
  // derivable by replaying the log (no `cwd` — its absence keeps an imported
  // run inert). Bounded by the 4 KiB event cap, tighter than routing's 8 KiB.
  // Use effectiveRouting (post-spill) so blob refs appear in the genesis event.
  const genesisPayload = JSON.stringify({
    workflowSha: params.workflowSha,
    priority: params.priority ?? 0,
    projectId,
    projectName,
    routing: effectiveRouting,
    contractVersion: EVENT_CONTRACT_VERSION,
    ...(params.workflowName != null ? { workflowName: params.workflowName } : {}),
    ...(params.workflowScope != null ? { workflowScope: params.workflowScope } : {}),
    ...(params.workflowPath != null ? { workflowPath: params.workflowPath } : {}),
    ...(params.scheduleId != null ? { scheduleId: params.scheduleId } : {}),
    ...(params.title != null && params.title.length > 0 ? { title: params.title } : {}),
    ...(params.baseGitSha != null ? { baseGitSha: params.baseGitSha } : {}),
    ...(params.baseGitRef != null ? { baseGitRef: params.baseGitRef } : {}),
    ...(params.baseHeadSha != null ? { baseHeadSha: params.baseHeadSha } : {}),
    ...(params.inCheckout === true ? { inCheckout: true as const } : {}),
  } satisfies RunEnqueuedPayload);
  const genesisBytes = utf8ByteLength(genesisPayload);
  if (genesisBytes >= MAX_EVENT_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(genesisBytes, MAX_EVENT_PAYLOAD_BYTES);
  }

  ctx.writeTxn(() => {
    if (!workflowExists(ctx.db, params.workflowSha)) {
      throw new Error(`unknown workflow sha ${params.workflowSha}`);
    }
    // The held read again under the write lock, so two enqueues racing on one
    // checkout cannot both pass the caller's pre-check.
    if (params.checkoutPath != null) {
      const holder = selectCheckoutHolder(ctx.db, params.checkoutPath);
      if (holder != null) throw new CheckoutBusyError(params.checkoutPath, holder);
    }
    // Insert blob rows for any values spilled to the CAS. The BlobFS.put()
    // calls happened before this transaction; the row insert is the
    // durability barrier that makes them reachable to reads and GC-protected.
    for (const { sha, bytes } of spilledBlobs) {
      insertBlobIfAbsent(ctx.db, sha, bytes, now);
    }

    insertRunState(ctx.db, {
      runId: params.runId,
      workflowSha: params.workflowSha,
      contractVersion: EVENT_CONTRACT_VERSION,
      routing,
      metrics,
      priority: params.priority ?? 0,
      enqueuedAt: now,
      readyAt: now,
      updatedAt: now,
      cwd,
      projectId,
      projectName,
      workflowName: params.workflowName ?? null,
      workflowScope: params.workflowScope ?? null,
      workflowPath: params.workflowPath ?? null,
      scheduleId: params.scheduleId ?? null,
      title: params.title != null && params.title.length > 0 ? params.title : null,
      baseGitSha: params.baseGitSha ?? null,
      baseGitRef: params.baseGitRef ?? null,
      baseHeadSha: params.baseHeadSha ?? null,
      inCheckout: params.inCheckout === true,
      checkoutPath: params.checkoutPath ?? null,
    });

    const seq = bumpRunSeq(ctx.db, params.runId);
    insertEventRunEnqueued(ctx.db, params.runId, seq, genesisPayload, now);
  });
  reputBlobs(ctx, spilledData);
}

export function claimNextRun(ctx: StoreCtx, maxInFlight: number): { runId: string; claimEpoch: number } | null {
  const now = ctx.now();
  let claimed: { runId: string; claimEpoch: number } | null = null;

  ctx.writeTxn(() => {
    // Capacity counts only runs the daemon could be executing here — imported
    // runs (inert by marker) never claim, so they must not burn a slot.
    if (countDispatchableRunningRuns(ctx.db) >= maxInFlight) return;

    const row = selectNextQueuedRun(ctx.db);
    if (row == null) return;

    claimed = claimQueuedRun(ctx.db, { runId: row.run_id, expectedVersion: row.version, now });
  });

  return claimed;
}

export function releaseClaim(
  ctx: StoreCtx,
  runId: string,
  claimEpoch: number,
  opts: { prevNode?: string; lastAliveAt?: number } = {},
): boolean {
  const row = selectRunStateRow(ctx.db, runId);
  if (row == null || row.status !== "running" || row.claim_epoch !== claimEpoch) return false;
  const payload: { prevNode?: string; lastAliveAt?: number } = {};
  const prevNode = opts.prevNode ?? row.current_node ?? undefined;
  if (prevNode !== undefined) payload.prevNode = prevNode;
  if (opts.lastAliveAt !== undefined) payload.lastAliveAt = opts.lastAliveAt;
  const payloadJson = ctx.validatePayload(payload);
  const activeMsDelta = crashRequeueActiveMsDelta(row.dispatch_started_at, opts.lastAliveAt);
  const ts = ctx.now();
  let released = false;
  ctx.writeTxn(() => {
    released = appendCrashRequeue(ctx.db, { runId, payloadJson, ts, activeMsDelta, claimEpoch });
  });
  return released;
}

export function startupSweep(ctx: StoreCtx, opts?: { priorHeartbeatAt?: number }): SweepResult {
  return runStartupSweep(ctx.db, ctx.now, opts);
}

export function setRunTitle(ctx: StoreCtx, runId: string, title: string): void {
  const clipped = title.length > 200 ? title.slice(0, 200) : title;
  const now = ctx.now();
  ctx.writeTxn(() => {
    updateRunStateTitle(ctx.db, runId, clipped, now);
  });
}

export function appendMessage(
  ctx: StoreCtx,
  runId: string,
  row: Omit<Message, "runId" | "ordinal" | "pass"> & { pass?: number },
  opts?: { dedup?: boolean },
): { ordinal: number } {
  // Pre-check before entering the transaction so the caller sees a typed
  // error rather than a CHECK constraint failure from SQLite. The schema
  // CHECK is defence-in-depth for any path that bypasses this method.
  const serialized = JSON.stringify(row.content);
  if (serialized.length >= MAX_MESSAGE_CONTENT_BYTES) {
    throw new MessageTooLargeError(serialized.length, MAX_MESSAGE_CONTENT_BYTES);
  }
  const contentHash = sha256Hex(serialized);
  const iteration = row.iteration ?? 0;
  const dedup = opts?.dedup === true && row.nodeId !== null;
  const ts = ctx.now();
  const role = row.content.role;
  const nodeId = row.nodeId;
  // Pre-serialize the static fields of the fact.message_appended payload. Only
  // `ordinal` is minted under the write lock, so it is spliced in as a bare
  // number and no JSON runs inside the transaction (I1). Size-checked here
  // against an upper-bound ordinal so the cap is still enforced pre-lock.
  const messageAppendedTail = `,"role":${JSON.stringify(role)},"nodeId":${nodeId == null ? "null" : JSON.stringify(nodeId)},"iteration":${iteration}}`;
  const messageAppendedGuardBytes = utf8ByteLength(`{"ordinal":${Number.MAX_SAFE_INTEGER}${messageAppendedTail}`);
  if (messageAppendedGuardBytes >= MAX_EVENT_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(messageAppendedGuardBytes, MAX_EVENT_PAYLOAD_BYTES);
  }
  let ordinal = 0;
  ctx.writeTxn(() => {
    // Opt-in dedup. When the caller asserts the message is replay-safe
    // (deterministic content given the same scope), passing `dedup: true`
    // causes a re-dispatch at the same `(run, node, iteration)` with
    // byte-identical content to return the existing ordinal instead of
    // minting a duplicate row.
    //
    // Default OFF because agent transcripts carry per-call timestamps
    // (and other mutable accounting fields) that legitimately differ
    // across attempts even when the semantic message is the same;
    // hashing the raw JSON would falsely refuse those dedups *or*
    // falsely allow them depending on timing. Handler-level
    // idempotency is the correct contract for those messages.
    if (dedup) {
      const existing = selectMessageByDedup(ctx.db, runId, row.nodeId as string, iteration, row.pass ?? 0, contentHash);
      if (existing != null) {
        ordinal = existing.ordinal;
        return;
      }
    }
    ordinal = selectMaxMessageOrdinal(ctx.db, runId) + 1;
    insertMessage(ctx.db, {
      runId,
      ordinal,
      content: serialized,
      nodeId: row.nodeId,
      iteration,
      pass: row.pass ?? 0,
      contentHash,
    });
    // Signal the per-run SSE stream that a new message row landed, so
    // clients can refetch the messages tail. Without this, tool-handler
    // appends are invisible to the client until the next llm
    // emits `agent.message_end`. Dedup hits don't insert a row, so
    // they don't emit either — the client's last refetch already
    // covers the existing ordinal.
    const eventPayload = `{"ordinal":${ordinal}${messageAppendedTail}`;
    const seq = bumpRunSeq(ctx.db, runId);
    insertEventDaemon(ctx.db, runId, seq, "fact.message_appended", eventPayload, ts);
  });
  return { ordinal };
}

export function putArtifact(
  ctx: StoreCtx,
  scope: ArtifactScope,
  content: Uint8Array,
  mime?: string,
  opts?: { replace?: boolean },
): ArtifactRef {
  if (content.byteLength > MAX_BLOB_BYTES) {
    throw new ArtifactTooLargeError(content.byteLength, MAX_BLOB_BYTES);
  }
  const sha = sha256Hex(content);
  const now = ctx.now();
  const bytes = content.byteLength;
  const replace = opts?.replace ?? false;

  // Replay-safe by default. If an artifact already exists at this scope:
  //  - same content → no-op, return the existing ref (replay produces
  //    the same logical state).
  //  - different content + !replace → ArtifactCollisionError. The handler
  //    is asking to overwrite something durable; force the call site to
  //    declare intent.
  //  - different content + replace → overwrite (the legacy behaviour,
  //    now opt-in).
  // See `docs/handler-contract.md` "replay semantics."
  const existing = ctx.store.getArtifactRef(scope);
  if (existing != null) {
    if (existing.sha256 === sha) {
      return existing;
    }
    if (!replace) {
      throw new ArtifactCollisionError(scope, existing.sha256, sha);
    }
  }

  // File-then-row: write the content-addressed file before the DB row
  // points at it. A crash between rename and INSERT leaves an orphan
  // file; the `blobs` row never references missing content.
  ctx.blobs.put(sha, content);

  ctx.writeTxn(() => {
    insertBlobIfAbsent(ctx.db, sha, bytes, now);
    upsertArtifact(ctx.db, {
      runId: scope.runId,
      nodeId: scope.nodeId,
      iteration: scope.iteration,
      key: scope.key,
      blobSha: sha,
      mime: mime ?? null,
      now,
    });
  });
  reputBlobs(ctx, [{ sha, data: content }]);

  return {
    ...scope,
    sha256: sha,
    sizeBytes: bytes,
    mime: mime ?? null,
  };
}

export function saveWorkflow(
  ctx: StoreCtx,
  sha: string,
  name: string,
  source: string,
  ir: string,
  irVersion: number,
): void {
  const now = ctx.now();
  ctx.writeTxn(() => {
    insertWorkflowIfAbsent(ctx.db, sha, name, source, ir, irVersion, now);
  });
}

export function vacuum(ctx: StoreCtx): void {
  ctx.db.exec("VACUUM");
}

/** Re-put blob files after the transaction that committed their rows. A
 * pre-txn `put()` that deduped onto an existing orphan file can race a GC in
 * another process that deletes that file before this commit lands; once the
 * row is committed GC can no longer collect it, so writing the content again
 * here (a no-op when the file is present) closes that window. Best-effort: the
 * write has already committed, so a failure here must not turn it into an
 * error the caller would treat as a failed (and retryable) write. */
export function reputBlobs(ctx: StoreCtx, blobs: ReadonlyArray<{ sha: string; data: Uint8Array }>): void {
  for (const { sha, data } of blobs) {
    try {
      ctx.blobs.put(sha, data);
    } catch (err) {
      console.warn(`[store] post-commit blob re-put failed for ${sha}:`, err);
    }
  }
}

/** A blob file younger than this is left alone by the file-side pass even
 * when no row names it: `putArtifact` and the routing spill write the file,
 * fsync, and only then commit the row, so a file this fresh is most likely a
 * write in flight, not a crash leftover. */
const ORPHAN_FILE_GRACE_MS = 5 * 60_000;

export function gcBlobs(ctx: StoreCtx, maxRows?: number): { deleted: number } {
  const limit = maxRows ?? 1000;

  // Pass 1: drop `blobs` rows with no artifact referent and not a routing /
  // outputs root. The roots are resolved inside the DELETE statement itself,
  // so nothing can become a root between the scan and the delete. The files go
  // under the same write lock: a writer in another process whose put() deduped
  // onto one of these files cannot commit its row until they are gone, and its
  // post-commit re-put then restores the content.
  let orphanShas: string[] = [];
  ctx.writeTxn(() => {
    orphanShas = deleteOrphanBlobs(ctx.db, limit);
    for (const sha of orphanShas) ctx.blobs.delete(sha);
  });

  // Pass 2: remove blob files with no matching row — left behind when a row
  // was deleted directly (cascade) or when a crash between put() and INSERT
  // orphaned the file. Bounded by the same per-sweep limit to keep tail
  // latency predictable. Root files (even those without a row, e.g. a
  // mid-write crash) are preserved, and so is any file still inside the
  // write-in-flight grace window. The directory walk and a racy pre-filter run
  // outside the lock; the authoritative row + root re-check and the deletes
  // run inside it, so a row committed after the walk still protects its file.
  let extraDeleted = 0;
  const budget = limit - orphanShas.length;
  if (budget > 0) {
    const roots = selectBlobRootShas(ctx.db);
    const candidates: string[] = [];
    for (const sha of ctx.blobs.listAllShas({ modifiedBefore: ctx.now() - ORPHAN_FILE_GRACE_MS })) {
      if (candidates.length >= budget) break;
      if (roots.has(sha) || blobRowExists(ctx.db, sha)) continue;
      candidates.push(sha);
    }
    if (candidates.length > 0) {
      const candidatesJson = JSON.stringify(candidates);
      ctx.writeTxn(() => {
        const deletable = selectDeletableOrphanFiles(ctx.db, candidatesJson);
        for (const sha of deletable) ctx.blobs.delete(sha);
        extraDeleted = deletable.length;
      });
    }
  }

  return { deleted: orphanShas.length + extraDeleted };
}
