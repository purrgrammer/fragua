import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { VALID_WRITERS } from "@fragua/types";
import { blobRowExists, insertBlobIfAbsent, upsertArtifact } from "./artifact-queries.ts";
import {
  asObject,
  assertBundleManifest,
  assertSha256,
  BUNDLE_VERSION,
  type BundleManifest,
  blobPath,
  canonicalJson,
  decodeJsonl,
  MANIFEST_ENTRY,
  readTar,
  runArtifactsPath,
  runEventsPath,
  runMessagesPath,
  workflowIrPath,
  workflowSourcePath,
} from "./bundle.ts";
import { insertEventOrIgnore, selectEvents } from "./event-queries.ts";
import { insertMessageOrIgnore } from "./message-queries.ts";
import { insertOutput } from "./outputs-queries.ts";
import { EVENT_CONTRACT_VERSION, MIN_COMPATIBLE_CONTRACT_VERSION } from "./pragmas.ts";
import { deriveRunState } from "./reducers.ts";
import { isBlobRef, maybeSpillStruct } from "./routing-blobs.ts";
import { assertSafeRunId } from "./run-id.ts";
import { insertRunState, markRunImported, setRunStateNextSeq, writeRunStateProjection } from "./run-state-queries.ts";
import { sha256Hex } from "./sha256.ts";
import type { StoreCtx } from "./store-ctx.ts";
import { reputBlobs } from "./store-writer.ts";
import { type ArtifactListRow, ConcurrencyError, type EventWriter, type ImportBundleResult } from "./types.ts";
import { insertWorkflowIfAbsent, selectWorkflow } from "./workflow-queries.ts";

/** Merge a `.fragua` bundle into this store so its runs are inspectable here
 * (`fragua runs status|events|messages`). `run_state` is DERIVED by replaying
 * each run's event log (`deriveRunState`) — the bundle carries no projection.
 * An imported run is inert by construction: its derived `cwd` is `null`, so
 * the daemon can never claim or provision it (no marker needed).
 *
 * Fail-closed on what blocks a safe read: an unknown `bundleVersion`, any
 * blob absent / failing its sha256, or a workflow whose source doesn't hash to
 * its sha (its IR is re-derived from source, never taken from the bundle). The
 * event-contract version is reported (`resumeCompatible`), not gated — a
 * too-new/too-old run still imports for inspection. A run already present
 * must be an imported one whose stored log is a prefix of the bundle's: an
 * identical log is a no-op, a longer one extends it and re-derives the
 * projection + `next_seq`; anything else is refused before any write. */
export function importRunBundle(ctx: StoreCtx, bytes: Uint8Array): ImportBundleResult {
  const entries = readTar(bytes);
  const byName = new Map(entries.map((e) => [e.name, e.data] as const));
  const manifestEntry = byName.get(MANIFEST_ENTRY);
  if (manifestEntry == null) throw new Error("importRunBundle: manifest.json missing from bundle");
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestEntry)) as BundleManifest;
  } catch {
    throw new Error("importRunBundle: manifest.json is not valid JSON");
  }
  assertBundleManifest(manifest);
  if (manifest.bundleVersion !== BUNDLE_VERSION) {
    throw new Error(
      `importRunBundle: unsupported bundleVersion ${manifest.bundleVersion} (this build reads ${BUNDLE_VERSION})`,
    );
  }
  const resumeCompatible =
    manifest.contractVersion >= MIN_COMPATIBLE_CONTRACT_VERSION && manifest.contractVersion <= EVENT_CONTRACT_VERSION;

  // Verify every manifest blob is present and hashes to its claimed sha BEFORE
  // any write — a tampered or truncated bundle fails closed.
  const blobs: { sha256: string; size: number; data: Uint8Array }[] = [];
  for (const b of manifest.blobs) {
    const data = byName.get(blobPath(b.sha256));
    if (data == null)
      throw new Error(`importRunBundle: blob ${b.sha256} is in the manifest but absent from the bundle`);
    const actual = sha256Hex(data);
    if (actual !== b.sha256) {
      throw new Error(`importRunBundle: blob ${b.sha256} failed its integrity check (bytes hash to ${actual})`);
    }
    blobs.push({ sha256: b.sha256, size: data.length, data });
  }
  const bundleBlobShas = new Set(blobs.map((b) => b.sha256));

  const workflows = manifest.workflows.map((w) => verifyBundleWorkflow(ctx, byName, w));

  // The format is multi-run by construction; a duplicate id would import the
  // first run then fail the second on a PK conflict (opaque SQLite error).
  const seenIds = new Set<string>();
  for (const r of manifest.runs) {
    if (seenIds.has(r.runId)) throw new Error(`importRunBundle: duplicate runId ${r.runId} in manifest`);
    seenIds.add(r.runId);
  }

  // Decode + derive every run OUTSIDE the write txn (I1: no JSON / alloc work
  // inside). Each run's `run_state` is reconstructed from its event log.
  const runsToImport = manifest.runs.map((r) => {
    assertSafeRunId(r.runId);
    const evData = byName.get(runEventsPath(r.runId));
    if (evData == null) throw new Error(`importRunBundle: run ${r.runId} has no events.jsonl`);
    const events = decodeJsonl(evData) as {
      seq: number;
      type: string;
      writer: EventWriter;
      payload: unknown;
      ts: number;
    }[];
    const msgData = byName.get(runMessagesPath(r.runId));
    const messages = (msgData == null ? [] : decodeJsonl(msgData)) as {
      ordinal: number;
      content: unknown;
      nodeId: string | null;
      iteration: number;
      /** Absent in bundles exported before schema v4 — import defaults to 0. */
      pass?: number;
    }[];
    const artData = byName.get(runArtifactsPath(r.runId));
    const artifacts = (artData == null ? [] : decodeJsonl(artData)) as ArtifactListRow[];

    // Untrusted event rows: reject a non-object row (a `null` line decodes to
    // null and would TypeError on `.writer`), gate the provenance `writer` to
    // the known set (the column has no CHECK, by design — but the import trust
    // boundary does), and require a string `type`/numeric `seq` so a malformed
    // row can't reach the events table.
    const seenSeqs = new Set<number>();
    for (const ev of events) {
      if (ev == null || typeof ev !== "object") {
        throw new Error(`importRunBundle: run ${r.runId} carries a non-object event row`);
      }
      // Primitive-shape gate FIRST — so a non-string writer (e.g. `{}`) is
      // rejected as a malformed row, not mislabeled "invalid writer" by the
      // membership test below (which only ever sees strings after this).
      if (typeof ev.type !== "string" || typeof ev.seq !== "number" || typeof ev.writer !== "string") {
        throw new Error(`importRunBundle: run ${r.runId} carries a malformed event (type/seq/writer)`);
      }
      if (!VALID_WRITERS.has(ev.writer)) {
        throw new Error(
          `importRunBundle: run ${r.runId} event seq ${ev.seq} has invalid writer ${JSON.stringify(ev.writer)}`,
        );
      }
      if (seenSeqs.has(ev.seq))
        throw new Error(`importRunBundle: run ${r.runId} carries duplicate event seq ${ev.seq}`);
      seenSeqs.add(ev.seq);
    }
    // Scope note: we shape-gate the row envelope (writer/type/seq) and the
    // GENESIS payload (below), but NOT every other event's `payload` — the
    // reducer is intentionally tolerant, an imported run is inert (never
    // executes here), and event payloads are INSERT OR IGNORE'd verbatim for
    // inspection. Gating every fact/intent payload shape would duplicate the
    // event-contract surface; it's deliberately out of scope.
    //
    // Same gate for transcript rows — `ordinal`/`iteration` numeric, `nodeId`
    // string-or-null — so a tampered messages.jsonl fails clearly here, not as
    // an opaque SQLITE_CONSTRAINT in the txn.
    for (const m of messages) {
      if (m == null || typeof m !== "object") {
        throw new Error(`importRunBundle: run ${r.runId} carries a non-object message row`);
      }
      if (typeof m.ordinal !== "number" || typeof m.iteration !== "number") {
        throw new Error(`importRunBundle: run ${r.runId} message has non-numeric ordinal/iteration`);
      }
      if (m.nodeId !== null && typeof m.nodeId !== "string") {
        throw new Error(`importRunBundle: run ${r.runId} message has a non-string nodeId`);
      }
    }
    // Artifact rows feed `upsertArtifact` and, through `blobSha`, the blob
    // store's path builder (`<root>/<sha[0:2]>/<sha>`) — so a crafted sha is a
    // path, and a sha the bundle doesn't carry would alias another run's
    // content already in this store. Gate the envelope, the sha shape, and
    // membership in the manifest before the txn.
    for (const a of artifacts) {
      if (a == null || typeof a !== "object") {
        throw new Error(`importRunBundle: run ${r.runId} carries a non-object artifact row`);
      }
      if (typeof a.nodeId !== "string" || typeof a.key !== "string") {
        throw new Error(`importRunBundle: run ${r.runId} artifact has a non-string nodeId/key`);
      }
      if (typeof a.iteration !== "number" || typeof a.createdAt !== "number") {
        throw new Error(`importRunBundle: run ${r.runId} artifact has a non-numeric iteration/createdAt`);
      }
      if (a.mime !== null && typeof a.mime !== "string") {
        throw new Error(`importRunBundle: run ${r.runId} artifact has a non-string mime`);
      }
      assertSha256(a.blobSha, `run ${r.runId} artifact ${a.nodeId}/${a.key} blobSha`);
      if (!bundleBlobShas.has(a.blobSha)) {
        throw new Error(
          `importRunBundle: run ${r.runId} artifact ${a.nodeId}/${a.key} names blob ${a.blobSha} the bundle does not carry`,
        );
      }
    }
    // Defense-in-depth: shape-gate the genesis identity fields BEFORE
    // deriveRunState consumes them, same discipline as the manifest shas. A
    // bare `!= null` sweep would admit a wrong-typed value (workflowSha:
    // 12345) or an array (`typeof [] === "object"`) and let it reach
    // insertRunState / FK lookups — type each field at the boundary (asObject
    // rejects arrays) and surface a clear error, not an opaque SQLITE_CONSTRAINT
    // in the txn. (deriveRunState re-finds genesis; this gate runs first so its
    // clearer errors win.)
    const genesis = events.find((e) => e.type === "intent.run_enqueued");
    if (genesis == null) throw new Error(`importRunBundle: run ${r.runId} has no genesis (intent.run_enqueued) event`);
    const gp = asObject(genesis.payload, `run ${r.runId} genesis payload`);
    assertSha256(gp["workflowSha"], `run ${r.runId} genesis workflowSha`);
    for (const f of ["projectId", "projectName"] as const) {
      if (typeof gp[f] !== "string") throw new Error(`importRunBundle: run ${r.runId} genesis ${f} is not a string`);
    }
    if (typeof gp["contractVersion"] !== "number") {
      throw new Error(`importRunBundle: run ${r.runId} genesis contractVersion is not a number`);
    }
    asObject(gp["routing"], `run ${r.runId} genesis routing`);
    const existing = classifyExistingRun(ctx, r.runId, events);

    const derived = deriveRunState(r.runId, events);
    // Rebuild the outputs index from node_completed facts, mirroring the live
    // append path so import and live agree (I1: JSON.stringify stays out of the
    // txn). An already-spilled output rides the payload as a `{$fragua_blob}`
    // ref (its blob ships in the bundle) → index the ref verbatim. An inline
    // struct is indexed as-is, or spilled to a blob here when it would breach
    // the `outputs.struct` CHECK (<4096) — never silently dropped (the prior
    // `length < 4096` guard skipped such a row, leaving the index incomplete).
    const outputsRows: Array<{ nodeId: string; iteration: number; structJson: string }> = [];
    const outputsSpilledBlobs: Array<{ sha: string; bytes: number }> = [];
    const outputsSpilledData: Array<{ sha: string; data: Uint8Array }> = [];
    for (const ev of events) {
      if (ev.type !== "fact.node_completed") continue;
      const p = ev.payload as { nodeId?: unknown; iteration?: unknown; outputs?: unknown };
      if (p.outputs === undefined || typeof p.nodeId !== "string" || typeof p.iteration !== "number") continue;
      if (isBlobRef(p.outputs)) {
        outputsRows.push({ nodeId: p.nodeId, iteration: p.iteration, structJson: JSON.stringify(p.outputs) });
        continue;
      }
      const structJson = JSON.stringify(p.outputs);
      const ref = maybeSpillStruct(structJson, (sha, bytes) => {
        ctx.blobs.put(sha, bytes);
        outputsSpilledData.push({ sha, data: bytes });
      });
      if (ref !== null) {
        outputsRows.push({ nodeId: p.nodeId, iteration: p.iteration, structJson: JSON.stringify(ref) });
        outputsSpilledBlobs.push({ sha: ref.$fragua_blob, bytes: ref.bytes });
      } else {
        outputsRows.push({ nodeId: p.nodeId, iteration: p.iteration, structJson });
      }
    }
    return {
      derived,
      outputsRows,
      outputsSpilledBlobs,
      outputsSpilledData,
      routingJson: JSON.stringify(derived.routing),
      metricsJson: JSON.stringify(derived.metrics),
      changeStatJson: derived.changeStat != null ? JSON.stringify(derived.changeStat) : null,
      eventRows: events.map((ev) => ({
        seq: ev.seq,
        type: ev.type,
        writer: ev.writer,
        payload: JSON.stringify(ev.payload),
        ts: ev.ts,
      })),
      messageRows: messages.map((m) => {
        const content = JSON.stringify(m.content);
        return {
          ordinal: m.ordinal,
          content,
          nodeId: m.nodeId,
          iteration: m.iteration,
          pass: m.pass,
          contentHash: sha256Hex(content),
        };
      }),
      artifacts,
      existing,
    };
  });

  const now = ctx.now();
  const result: { runId: string; imported: boolean }[] = [];

  // Blob files before the txn (fs I/O); reap any orphan if the txn throws.
  try {
    for (const b of blobs) ctx.blobs.put(b.sha256, b.data);

    ctx.writeTxn(() => {
      for (const w of workflows) insertWorkflowIfAbsent(ctx.db, w.sha, w.name, w.source, w.ir, w.irVersion, now);
      for (const b of blobs) insertBlobIfAbsent(ctx.db, b.sha256, b.size, now);

      for (const r of runsToImport) {
        const d = r.derived;
        if (r.existing.mode === "new") {
          insertRunState(ctx.db, {
            runId: d.runId,
            workflowSha: d.workflowSha,
            contractVersion: d.contractVersion,
            routing: r.routingJson,
            metrics: r.metricsJson,
            priority: d.priority,
            enqueuedAt: d.enqueuedAt,
            readyAt: d.readyAt,
            updatedAt: d.updatedAt,
            cwd: null, // a local binding — absent from the log; keeps the run inert
            projectId: d.projectId,
            projectName: d.projectName,
            workflowName: d.workflowName,
            workflowScope: d.workflowScope,
            workflowPath: d.workflowPath,
            scheduleId: d.scheduleId,
            baseGitSha: d.baseGitSha,
            baseGitRef: d.baseGitRef,
            baseHeadSha: d.baseHeadSha,
            inCheckout: d.inCheckout,
            checkoutPath: null, // a local binding — an imported run never holds a checkout
          });
        }
        if (r.existing.mode !== "identical") {
          // A fresh row was inserted at version 1; an extension replaces the
          // projection over the merged log (the stored log is a prefix of the
          // bundle's, so `derived` already is its replay).
          const expectedVersion = r.existing.mode === "new" ? 1 : r.existing.expectedVersion;
          const applied = writeRunStateProjection(ctx.db, {
            runId: d.runId,
            version: d.version,
            expectedVersion,
            status: d.status,
            currentNode: d.currentNode,
            routingJson: r.routingJson,
            metricsJson: r.metricsJson,
            lastAppliedSeq: d.lastAppliedSeq,
            priority: d.priority,
            readyAt: d.readyAt,
            nodeStartedAt: d.nodeStartedAt,
            dispatchStartedAt: d.dispatchStartedAt,
            updatedAt: d.updatedAt,
            baseGitSha: d.baseGitSha,
            baseGitRef: d.baseGitRef,
            baseHeadSha: d.baseHeadSha,
            checkoutReleased: d.checkoutReleased,
            finalGitSha: d.finalGitSha,
            finalHeadRef: d.finalHeadRef,
            diffBaseSha: d.diffBaseSha,
            changeStatJson: r.changeStatJson,
            inboxStatus: d.inboxStatus,
            acceptedSha: d.acceptedSha,
          });
          if (!applied) throw new ConcurrencyError(expectedVersion, -1);
          setRunStateNextSeq(ctx.db, d.runId, d.nextSeq);
        }
        if (r.existing.mode === "new") {
          // Authoritative inert marker: holds the run out of dispatch /
          // concurrency / sweep regardless of its derived status (a
          // non-terminal source run derives to queued/running but must never
          // execute here). An extension keeps the marker it already carries.
          markRunImported(ctx.db, d.runId, now);
        }
        for (const ev of r.eventRows) {
          insertEventOrIgnore(ctx.db, d.runId, ev.seq, ev.type, ev.writer, ev.payload, ev.ts);
        }
        for (const m of r.messageRows) {
          insertMessageOrIgnore(ctx.db, {
            runId: d.runId,
            ordinal: m.ordinal,
            content: m.content,
            nodeId: m.nodeId,
            iteration: m.iteration,
            pass: m.pass ?? 0,
            contentHash: m.contentHash,
          });
        }
        // Durability barrier for any output struct spilled during import:
        // the blob was written to the FS in the map above; make it reachable
        // + GC-protected before the index row that references it lands.
        for (const b of r.outputsSpilledBlobs) {
          insertBlobIfAbsent(ctx.db, b.sha, b.bytes, now);
        }
        // Rebuild the outputs index from node_completed facts.
        for (const o of r.outputsRows) {
          insertOutput(ctx.db, d.runId, o.nodeId, o.iteration, o.structJson);
        }
        for (const a of r.artifacts) {
          upsertArtifact(ctx.db, {
            runId: d.runId,
            nodeId: a.nodeId,
            iteration: a.iteration,
            key: a.key,
            blobSha: a.blobSha,
            mime: a.mime,
            now: a.createdAt,
          });
        }
        result.push({ runId: d.runId, imported: r.existing.mode !== "identical" });
      }
    });
  } catch (err) {
    for (const b of blobs) {
      if (!blobRowExists(ctx.db, b.sha256)) ctx.blobs.delete(b.sha256);
    }
    // Reap any output struct spilled during the map whose index row didn't
    // land (txn rolled back) — same orphan-blob discipline as the bundle blobs.
    for (const r of runsToImport) {
      for (const b of r.outputsSpilledBlobs) {
        if (!blobRowExists(ctx.db, b.sha)) ctx.blobs.delete(b.sha);
      }
    }
    throw err;
  }
  reputBlobs(
    ctx,
    blobs.map((b) => ({ sha: b.sha256, data: b.data })),
  );
  for (const r of runsToImport) reputBlobs(ctx, r.outputsSpilledData);

  return { runs: result, resumeCompatible };
}

type ExistingRun = { mode: "new" } | { mode: "identical" } | { mode: "extend"; expectedVersion: number };

/** A bundle may only ever write into a run this store holds as an import, and
 * only by extending it: appending into a run this store executes would inject
 * intents and collide with its `next_seq`. Every stored event must reappear in
 * the bundle unchanged (seq/type/writer/payload) and the bundle may add only
 * events past the stored max seq. */
function classifyExistingRun(
  ctx: StoreCtx,
  runId: string,
  events: readonly { seq: number; type: string; writer: string; payload: unknown }[],
): ExistingRun {
  const state = ctx.store.getState(runId);
  if (state == null) return { mode: "new" };
  if (state.imported !== true) {
    throw new Error(`importRunBundle: run ${runId} exists locally and is not an imported run`);
  }
  const notPrefix = (seq: number) =>
    new Error(`importRunBundle: run ${runId} stored event log is not a prefix of the bundle's (seq ${seq})`);
  const bundleBySeq = new Map(events.map((e) => [e.seq, e] as const));
  const stored = selectEvents(ctx.db, runId, { sinceSeq: Number.MIN_SAFE_INTEGER });
  let storedMax = Number.NEGATIVE_INFINITY;
  for (const s of stored) {
    const b = bundleBySeq.get(s.seq);
    if (
      b == null ||
      b.type !== s.type ||
      b.writer !== s.writer ||
      canonicalJson(b.payload) !== canonicalJson(JSON.parse(s.payload))
    ) {
      throw notPrefix(s.seq);
    }
    storedMax = s.seq;
  }
  const storedSeqs = new Set(stored.map((s) => s.seq));
  const gap = events.find((e) => e.seq <= storedMax && !storedSeqs.has(e.seq));
  if (gap != null) throw notPrefix(gap.seq);
  return events.some((e) => e.seq > storedMax)
    ? { mode: "extend", expectedVersion: state.version }
    : { mode: "identical" };
}

/** The workflows table is shared with locally-authored runs and keyed by
 * content hash with insert-if-absent, so a row whose source doesn't hash to
 * its sha would shadow the genuine workflow for every later `fragua run`.
 * Verify the sha against the source, derive the IR from that source (the
 * bundle's `ir.json` is never trusted), and require an existing row to agree. */
function verifyBundleWorkflow(
  ctx: StoreCtx,
  byName: Map<string, Uint8Array>,
  w: BundleManifest["workflows"][number],
): { sha: string; name: string; source: string; ir: string; irVersion: number } {
  const sourceBytes = byName.get(workflowSourcePath(w.sha));
  if (sourceBytes == null || byName.get(workflowIrPath(w.sha)) == null) {
    throw new Error(`importRunBundle: workflow ${w.sha} is in the manifest but its source/ir entry is absent`);
  }
  const actual = sha256Hex(sourceBytes);
  if (actual !== w.sha) throw new Error(`importRunBundle: workflow ${w.sha} source hashes to ${actual}`);
  let source: string;
  try {
    // fatal + ignoreBOM: the stored string must re-encode to exactly the hashed bytes.
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(sourceBytes);
  } catch {
    throw new Error(`importRunBundle: workflow ${w.sha} source is not valid UTF-8`);
  }
  let ir: string;
  try {
    ir = serializeGraph(parseWorkflow(source));
  } catch (err) {
    throw new Error(
      `importRunBundle: workflow ${w.sha} source does not parse under this build: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const existing = selectWorkflow(ctx.db, w.sha);
  if (existing != null) {
    if (existing.source !== source) {
      throw new Error(`importRunBundle: workflow ${w.sha} exists locally with different source`);
    }
    // A row saved under an older IR version can't byte-match a freshly derived IR.
    if (existing.ir_version === CURRENT_IR_VERSION && existing.ir !== ir) {
      throw new Error(`importRunBundle: workflow ${w.sha} exists locally with a different IR`);
    }
  }
  return { sha: w.sha, name: w.name, source, ir, irVersion: CURRENT_IR_VERSION };
}
