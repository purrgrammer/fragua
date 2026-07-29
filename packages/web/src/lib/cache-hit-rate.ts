// The one definition of "cache hit rate" in the app.
//
// Four surfaces render this number (Home + ProjectDetail via `stats.ts`, the
// live run tile via `useLiveCostAggregate.ts`, `Analytics.tsx`, and
// `RunDetail.tsx`). They each used to inline the arithmetic and defer the
// rationale to a comment pointing at a function nothing called, which is
// exactly the drift that lets four copies quietly stop agreeing.

/**
 * Share of prompt-token-equivalents served from cache:
 *
 *   cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
 *
 * **Output tokens are deliberately absent.** Caching applies to the prompt
 * only — output is generated fresh on every call and can never be a cache
 * read. Including it would make the number drop when a model simply gets more
 * verbose, reporting a cache regression where the prefix never changed.
 *
 * **`cacheWriteTokens` is deliberately present.** It counts the prompt-token
 * cost of *writing* the cache, not just the cost of fresh input. Drop it and
 * the denominator collapses once a thread is warm — real runs bottom out at
 * single-digit `inputTokens`, so `read / (input + read)` reports ~99.99% for
 * anything past the first turn and the tile reads a meaningless "100%".
 *
 * The three inputs must be **disjoint** for this to mean anything, and they
 * are: Anthropic reports them as separate buckets, while OpenAI and Google
 * report cached tokens *inside* the prompt count and pi-ai subtracts them out
 * before fragua ever sees a `cost.recorded` payload.
 *
 * Note this is a *token* share, not a cost saving — cache writes bill above
 * base rate and output is untouched by caching, so the dollar figure is
 * materially lower than this number suggests.
 *
 * Returns `undefined` when any argument is non-finite or the denominator is
 * zero, so callers can distinguish "no data" from a real 0%.
 */
export function cacheHitRate(
  inputTokens: number | null | undefined,
  cacheReadTokens: number | null | undefined,
  cacheWriteTokens: number | null | undefined,
): number | undefined {
  if (!isFiniteNumber(inputTokens) || !isFiniteNumber(cacheReadTokens) || !isFiniteNumber(cacheWriteTokens)) {
    return undefined;
  }
  const denom = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (denom <= 0) return undefined;
  const rate = cacheReadTokens / denom;
  return Number.isFinite(rate) ? rate : undefined;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
