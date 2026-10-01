# Arbitration — tool-outputs.md

> Status: sketch. Arbitration companion to [`tool-outputs.md`](tool-outputs.md);
> tracks its status.

Verdicts: adversarial=revise, feasibility=revise, clarity=revise, precedent=approve, scope=approve.
Not unanimous → arbitrate.

## Rulings

- **Adversarial-1 structural options vs Scope/Precedent minimalism.** RULE for scope on the
  *structural* remedies. A distinct `producer.*` outcome/fault edge IS the data-driven-routing
  door the proposal defers with argument; restricting `outputs:`-tools to side-effect-free IS the
  `pure`-marker door it defers with argument. Both were also explicitly cut in Rejected
  alternatives (dedicated `producerFault` field). Neither is re-openable here. What survives is
  only the *documentation* consequence (see Blocking B3), which adds no mechanism.

- **Adversarial-2 rename detection vs Scope's "never trust a stat" / retained-fd minimalism.**
  RULE split. The read PATH stays retained-fd-only — no re-open, no stat-for-reading; the DoS
  argument and the smaller design stand. But a diagnostic-only inode/size comparison on the
  *already-failed* `absent` path (an `fstat` on the retained fd vs the path) neither streams bytes
  nor adds routing, so it does not reopen the rejected re-open-by-path class. The design decision
  *not to support atomic-rename* stands; the demand *not to silently misreport it* survives
  (B2). This is an error-quality fix, not a return to the rejected alternative.

- **Clarity-2 (`bytes?`) vs "never trust a stat" invariant.** No cross-lens conflict — the minimal
  fix (remove the unused field) satisfies both clarity and scope. Kept as B4.

## Blocking (ordered by leverage)

- **B1 — feasibility: add `docs/handler-contract.md` to *Contracts reversed* + Docs touch-surface.**
  Verified in-tree: `docs/handler-contract.md:92` asserts `outputs?: … from emit_output (llm steps
  with outputs: declared)` and `:314–320` asserts "tool nodes do not feed data forward … call the
  script from inside an llm step's `bash` tool instead" + "a distinct primitive for side-effect-only
  shell steps." AGENTS.md ground rule 1 names this file authoritative ("handler API"). The proposal
  enumerates SPEC/ARCH/workflows-skill/docs-workflows/AGENTS but omits this file — the exact
  stale-authoritative-doc failure it flags for the workflows skill (entry 6). Add both edit sites.

- **B2 — adversarial: stop silently misreporting a rename-based emission as `no_emission`.**
  Common safe idioms (`jq . in > tmp && mv tmp "$FRAGUA_OUTPUT"`, `--output`, `sponge`, atomic-save)
  swap the path to a new inode the retained fd never sees → `absent` → `producer.no_emission`, then
  `dispose()` unlinks the evidence — a correct-looking command misreported with no debuggable trail.
  Demand: on the `absent` path, distinguish "path now holds bytes on a different inode than the
  retained fd" and surface an actionable diagnostic naming the in-place-`>` requirement (e.g.
  `producer.rename_not_supported`), rather than `no_emission`; and don't destroy the evidence
  silently before that diagnostic is captured. (Read path stays retained-fd-only per the ruling —
  no re-open, no rename *support*.)

- **B3 — adversarial (reduced): document the exit-0/side-effecting-producer consequence.**
  The proposal reverses "exit 0 → success" for producers but discusses re-run safety only on the
  crash/quarantine/`idempotent:` path, not the fail-EDGE path. Add: a post-exit-0 emission failure
  (oversize/unparseable/invalid) surfaces as `outcome=fail`, indistinguishable at the fail edge from
  a command failure; exit 0 is therefore no longer a total-success guarantee for producers; the
  pre-existing "fail edge routed into re-run re-executes a committed side effect" hazard applies
  unchanged, and a side-effecting producer is the author's responsibility (idempotent design; do not
  route `fail` into re-charge). NOTE: do not adopt the demand's "emission failure implies effects DID
  occur" phrasing — it is false (emission can fail before any side effect).

- **B4 — clarity: define or remove `bytes?` on `{ kind: "oversize"; bytes?: number }`.**
  Nothing in the doc says what it holds; one plausible reading (stat the file to fill it) directly
  contradicts the design's load-bearing "never trusts a stat-reported size" invariant. The handler
  maps oversize → `producer.invalid_emission` regardless of count, so the field is unused — removing
  it is the minimal fix; otherwise state `undefined` or `maxBytes+1`.

## Deferred (visible, not lost)

- clarity: "re-check `isAbortError` first" → "check" — both readings yield correct code (one guard,
  or a harmless redundant second). Wording polish, non-blocking.
- notes: JSDoc "(now-empty, since the child unlinked it)" mis-states POSIX unlink (inode data
  survives unlink); the retained fd reads whatever was written before unlink. Tighten the causal
  phrasing; non-blocking, no impl fork.
- notes: "settles the open `exec:`-vs-`run:` question" register break — state the closed position
  directly. Taste.
- notes: frontmatter `summary:` is a 280-word single sentence; two-sentence form reads better. Taste.
- notes: "ToolConfig's closed `attrs` param" — "closed" is undefined jargon (also the closed type is
  `specForNode`'s param). Minor imprecision, non-blocking.
- scope/precedent soft concerns: `makeReadOnlyEnv` would need to forward `createScratchFile` if a
  producing tool ever gains `allowed-tools` narrowing (note-worthy, not required now); outputs key
  omits `pass`/goal-gate epoch (pre-existing llm-producer property); 8 MiB attacker-controlled CAS
  write is store-growth pressure, not a crash. All non-blocking.
