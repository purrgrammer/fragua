# P5.11 — Visual regression + cost reconciliation

## Goal
Lock in the web UI's appearance with Playwright screenshot tests and add unit
tests proving the cost aggregation matches what providers actually bill. This
is the verification gate for the P5 deliverables.

## Depends on
- P5.06 (Graph view)
- P5.07 (Timeline)
- P5.08 (Drilldown)

## Scope

- Files to create:
  - `packages/web/playwright.config.ts`
  - `packages/web/e2e/graph-view.spec.ts` — launch a mock pipeline, screenshot, compare baseline
  - `packages/web/e2e/timeline.spec.ts`
  - `packages/web/e2e/drilldown.spec.ts`
  - `packages/web/e2e/fixtures/` — reusable mock events + DOT sources
  - `packages/web/e2e/baselines/*.png` — committed screenshot baselines
  - `packages/agent/test/cost-reconciliation.test.ts` — synthetic usage → cost via `calculateCost`, assert match against known Anthropic + OpenAI + OpenRouter prices within 1%
- Files to modify:
  - root `package.json` — add `test:e2e` script: `playwright test`
  - `.github/workflows/ci.yml` (if exists) — add a separate job for e2e
- Dependencies:
  - Add `@playwright/test` (pinned)

## Tests

- `graph-view.spec.ts`: fixture pipeline, screenshot matches baseline within
  0.5% pixel difference
- `timeline.spec.ts`: screenshot after 50 events streamed; filter toggle
  changes the visible count
- `drilldown.spec.ts`: click a node, screenshot the conversation with thinking
  blocks visible
- `cost-reconciliation.test.ts`:
  - Mock 1M input / 500K output tokens on `claude-haiku-4-5` → expected cost
    matches Anthropic's published price table
  - Same on `gpt-4o` → matches OpenAI's price table
  - OpenRouter's markup is captured in `calculateCost` (their pricing rides
    the underlying model's data)

## Verification

- `bun run ci` passes
- `bun run test:e2e` passes (CI can skip or gate behind a secret)
- Manual smoke: run a real pipeline end-to-end, open the web UI, verify cost
  panel matches what Anthropic's billing portal shows (within 1%)

## Out of scope

- Cross-browser testing — Chromium only for now
- Mobile viewport screenshots
- Accessibility audit (follow-up after P5 lands)

## Reusable patterns

- Cost logic: pi-ai's `calculateCost` lives in `@mariozechner/pi-ai` — reuse, don't reimplement
- Fixture pipelines: reuse `examples/hello.dot` and `examples/parallel-review.dot`
- Events fixtures: extract a real `.swarm/runs/<id>/events.jsonl` and commit it to `packages/web/e2e/fixtures/`
