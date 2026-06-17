// End-to-end property test for the secret-scrubber (docs/proposals/secret-scrubbing.md §12).
//
// Property: a randomly-generated secret seeded into EVERY scrubbable surface of a run
// is ABSENT from the exported bundle bytes — verbatim AND in each declared encoding
// (base64, base64url, percent) for the literal credential, and verbatim for
// pattern-shaped secrets. The bundle must also remain structurally sound (importRunBundle
// succeeds and derives a valid run status).
//
// Scope: DECLARED encoding set only. Split-across-fields, reworded, or homebrew-encoded
// forms are NOT asserted — those are the perimeter's job (§12, §6).

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import { type FactEvent, type IntentEvent, newRunId } from "../src/index.ts";
import { freshStore, seedWorkflow } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Encoding helpers — mirror registry.ts's encoding-expand step.
// ---------------------------------------------------------------------------

function toBase64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function toPercent(s: string): string {
  return encodeURIComponent(s);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * A literal credential value: >= 12 chars, no whitespace, safe for the
 * registry value-length floor (>= 8) and the literal match test.
 * Uses printable ASCII to keep base64/percent expansions deterministic.
 */
const literalSecretArb = fc
  .stringOf(
    fc.char().filter((c) => c !== " " && c !== "\t" && c !== "\n" && c !== "\r"),
    { minLength: 12, maxLength: 40 },
  )
  .filter((s) => !/\s/.test(s));

/**
 * A pattern-shaped secret: "AKIA" + 16 uppercase-alnum chars.
 * BASE_PATTERNS catches this as `pattern:aws_access_key_id`.
 * Deliberately has no registry entry — pattern-only coverage.
 */
const patternSecretArb = fc
  .stringOf(fc.constantFrom(...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")), {
    minLength: 16,
    maxLength: 16,
  })
  .map((suffix) => `AKIA${suffix}`);

// ---------------------------------------------------------------------------
// Run seeder
// ---------------------------------------------------------------------------

/**
 * Seed a run that embeds both `literal` and `pattern` secrets into every
 * scrubbable surface:
 *   - message content text
 *   - fact.tool_completed.preview
 *   - fact.run_paused_human.text (HITL pause)
 *   - fact.run_paused.errorMessage (provider error pause)
 *   - fact.run_halted.detail
 *   - intent.steering_requested.text
 *   - intent.human_input.note
 *   - genesis routing.inputs value spilled to blob (> 1 KiB, blob-scrub path)
 *   - text artifact (mime text/plain)
 */
async function seedRunWithBothSecrets(
  store: ReturnType<typeof freshStore>,
  literal: string,
  pattern: string,
): Promise<string> {
  const sha = await seedWorkflow(store, "f".repeat(64));
  const runId = newRunId();
  const combined = `${literal} ${pattern}`;

  // Pad the spilled input to > PER_VALUE_SPILL_BYTES (1024) so B1 spills it to
  // the blob CAS. The secrets sit in the blob; the e2e gate must scrub the blob.
  const spilledValue = `${"a".repeat(1100)} ${combined} ${"b".repeat(200)}`;

  store.enqueueRun({
    runId,
    workflowSha: sha,
    cwd: "/home/dev/proj",
    initialRouting: {
      input: `input contains ${combined}`,
      inputs: { secret: spilledValue },
    },
  });

  store.upsertProviderCredential({
    provider: "anthropic",
    kind: "api_key",
    payload: JSON.stringify({ type: "api_key", key: literal }),
  });

  // Message with both secrets in content.
  store.appendMessage(runId, {
    content: {
      role: "user" as const,
      content: [{ type: "text", text: `message body: ${combined}` }],
      timestamp: 1,
    },
    nodeId: "work",
    iteration: 0,
  });

  // Text artifact containing both secrets.
  store.putArtifact(
    { runId, nodeId: "work", iteration: 0, key: "output.txt" },
    new TextEncoder().encode(`artifact content: ${combined}`),
    "text/plain",
  );

  let v = store.getState(runId)!.version;

  const started: FactEvent = {
    type: "fact.run_started",
    payload: {
      workflowSha: sha,
      contractVersion: 1,
      startNode: "work",
      baseGitSha: "base",
      baseGitRef: "main",
    },
  };
  v = store.appendFact(runId, [started], v).newVersion;

  // fact.tool_completed.preview — surface 5.
  v = store.appendFact(
    runId,
    [
      {
        type: "fact.tool_completed",
        payload: {
          toolName: "bash",
          argsHash: "abc",
          artifactKey: "output.txt",
          preview: `tool preview ${combined}`,
        },
      } as FactEvent,
    ],
    v,
  ).newVersion;

  // fact.run_paused_human.text — HITL pause with both secrets in the prompt.
  v = store.appendFact(
    runId,
    [
      {
        type: "fact.run_paused",
        payload: { reason: "human", nodeId: "work", text: `approve? ${combined}`, routes: ["approve", "reject"] },
      } as FactEvent,
    ],
    v,
  ).newVersion;

  // fact.run_resumed to keep state machine valid.
  v = store.appendFact(runId, [{ type: "fact.run_resumed", payload: {} } as FactEvent], v).newVersion;

  // fact.run_paused.errorMessage — provider error with literal in error.
  v = store.appendFact(
    runId,
    [
      {
        type: "fact.run_paused",
        payload: {
          reason: "provider_error",
          nodeId: "work",
          httpStatus: 500,
          provider: "anthropic",
          errorMessage: `error: ${combined} caused failure`,
        },
      } as FactEvent,
    ],
    v,
  ).newVersion;

  // fact.run_resumed again.
  v = store.appendFact(runId, [{ type: "fact.run_resumed", payload: {} } as FactEvent], v).newVersion;

  // intent.steering_requested.text — steering with both secrets.
  store.appendIntent(runId, {
    type: "intent.steering_requested",
    payload: { text: `steer with ${combined}` },
  } as IntentEvent);

  // intent.human_input.note — human input note with literal.
  store.appendIntent(runId, {
    type: "intent.human_input",
    payload: { route: "default", note: `human note ${combined}` },
  } as IntentEvent);

  // Terminal: fact.run_halted.detail — both secrets in detail.
  store.appendFact(
    runId,
    [
      {
        type: "fact.run_terminated",
        payload: { status: "errored", reason: "error", detail: `halted: ${combined}` },
      } as FactEvent,
    ],
    v,
  );

  return runId;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("P-scrub-e2e — secret-free bundle (§12 capstone gate)", () => {
  test("literal and pattern secrets are absent from bundle bytes across all declared encodings", async () => {
    await fc.assert(
      fc.asyncProperty(literalSecretArb, patternSecretArb, async (literal, pattern) => {
        const store = freshStore();
        const runId = await seedRunWithBothSecrets(store, literal, pattern);

        const { bytes } = store.exportRunBundle(runId, { fraguaVersion: "0.0.0-test" });
        const buf = Buffer.from(bytes);

        // --- Literal secret: verbatim + declared encoding set ---
        expect(buf.includes(literal)).toBe(false);
        expect(buf.includes(toBase64(literal))).toBe(false);
        expect(buf.includes(toBase64Url(literal))).toBe(false);
        expect(buf.includes(toPercent(literal))).toBe(false);

        // --- Pattern-shaped secret: verbatim only (patterns don't expand encodings) ---
        expect(buf.includes(pattern)).toBe(false);

        // --- Structural integrity: importRunBundle succeeds and derives status ---
        const dst = freshStore();
        const result = dst.importRunBundle(bytes);
        expect(result.runs).toEqual([{ runId, imported: true }]);
        const state = dst.getState(runId)!;
        expect(state).not.toBeNull();
        expect(typeof state.status).toBe("string");
        // Status must be a recognized terminal or non-terminal value.
        expect(["queued", "running", "paused", "paused_human", "completed", "halted", "cancelled"]).toContain(
          state.status,
        );

        dst.close();
        store.close();
      }),
      { numRuns: pbtRuns(50) },
    );
  });
});
