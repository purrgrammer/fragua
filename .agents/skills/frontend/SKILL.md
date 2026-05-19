---
name: frontend
description: React code patterns for packages/web. Load this skill before writing or modifying any .tsx/.ts under packages/web/src — components, hooks, routes, data-fetching, mutations, tests — including small changes like adding a useState, wiring a fetch or a POST/DELETE, extracting a child component, adding an onClick that mutates server state, or writing a test. Encodes small components with clear seams, server state through @tanstack/react-query query factories (never useState + useEffect for fetches), mutations through useMutation with cache invalidation, effects reserved for subscriptions, hooks over HOCs, measure before memoizing, tests that describe user behavior. Pair with the `design` skill for anything touching styles, tokens, or layout.
---

# Frontend code patterns

*Small pieces. Server state in react-query. Effects are for subscriptions. Tests describe what the user does.*

Foundational patterns only. If a situation isn't here, derive it from the principles.

---

## Principles (earlier wins on conflict)

1. **Small components, composed.** A route orchestrates; leaves render. The moment a file passes ~40 lines of JSX or a third boolean prop, it wants to split.
2. **Server state lives in react-query.** Anything that came from the network belongs in the query cache — not in a `useState` you populate from a `useEffect`. The cache handles dedup, retry, staleness, and cross-view sharing. Rolling your own loses all of that.
3. **Effects are for subscriptions.** SSE streams, window events, interval tickers that aren't fetches. If an effect ends with `setState(data)`, it's a fetch in disguise — use `useQuery`.
4. **Hooks encapsulate behavior. Components compose it.** Reach for a custom hook the second time the same effect/state shape repeats, not the first — but don't wait for the third.
5. **Memoize when you can name the cost.** `useMemo` and `useCallback` have their own overhead. Use them for a stable reference a memoized child depends on, or a computation you measured. Default: omit.
6. **Tests describe what the user does.** Queries by role/label/text, assertions on what's on screen. No tree snapshots, no implementation-detail asserts.

---

## Data fetching

Every non-stream read from the server goes through `@tanstack/react-query`. The provider is mounted at `App.tsx`; the shared `QueryClient` is built by `lib/query-client.ts`. Don't remount either.

### Query factories

All query configs live in `lib/queries.ts`. Never hand-write a query key or query config at a call site — the factory is the one audit point, and composed keys mean invalidation doesn't drift.

Call shape:

```ts
import { useQuery } from "@tanstack/react-query";
import { queries } from "../lib/queries.ts";

const { data, isPending, isError } = useQuery(queries.runs.list());
```

Invalidate a whole domain:

```ts
qc.invalidateQueries({ queryKey: queries.runs.all() });
```

`lib/api.ts` exports plain async functions — `listRuns()`, `getRun(id)`, etc. The factory's `queryFn` calls them directly; nothing threads through props.

Three properties fall out of this shape:

- **Composable keys.** `queries.runs.all()` is the root; `list` and `detail(id)` extend it. Invalidating the root blows away every runs query in the cache in one line.
- **Type-safe end to end.** `queryOptions()` preserves the return type of `queryFn`, so `useQuery(...).data` is fully typed with no generics at the call site.
- **Build vs execute separated.** The factory returns config. `useQuery`, `queryClient.prefetchQuery`, and `queryClient.invalidateQueries` all consume the same object — so you can prefetch on hover with the exact config the route will use.

### Adding a new endpoint

Add the factory entry to `lib/queries.ts` **before** the hook call that needs it. Keys are tuples built from the domain's `all()` root. Keep the config as narrow as possible — only set `refetchInterval`, `staleTime`, etc. when the behavior actually differs from the defaults in `query-client.ts`.

### Components never call `api.*` directly

If you see `api.listX()` inside a component, something has jumped a layer. Route the call through `useQuery(queries.x.list(api))` (or `useMutation` when that lands). The one audit point is `lib/queries.ts`.

### Loading, error, empty

Render as named components (`<EmptyState>`, a dedicated loading row/skeleton), not as inline ternaries holding a sentence of copy. The intent is legible from the JSX.

### Mutations

Anything that mutates server state goes through `useMutation`, not a bare call from an `onClick`. The payoff is the same as queries: retry/error states handled for you, and — crucially — a single place to invalidate stale cache so the UI reflects the change.

```ts
const qc = useQueryClient();
const { mutate: cancel, isPending } = useMutation({
  mutationFn: (jobId: string) => cancelJob(jobId),
  onSuccess: () => qc.invalidateQueries({ queryKey: queries.jobs.all() }),
});
```

Invalidate at the `all()` root of every domain the mutation touches — cancelling a job also changes a run's state, so invalidate both `queries.jobs.all()` and `queries.runs.all()`. Err on the side of invalidating more: the cost is one refetch, the bug-cost of a stale view is much higher.

### SSE is not react-query

`useSSE` / `useRunConversation` stay as they are. Streams and subscriptions belong in effects — react-query is request/response. This split is intentional, not a TODO.

---

## Component shape

- One component per file once it grows past ~40 JSX lines. Extract early; extraction is reversible.
- Props typed explicitly. No `any`, no `React.FC`.
- Prefer composition over adding a third boolean prop. `<Thing variant="x" />` is usually two components under a union.
- Route components own data hooks + layout. Leaves receive props and render — they don't fetch.

---

## Hooks

- Extract a custom hook the second time the same shape repeats (`useFoo`, `usePolledX`). Hooks are behavior; components compose behavior.
- Respect the Rules of Hooks — no conditional calls, stable call order per render. Lint catches most of these.
- `useMemo`/`useCallback` need a named reason: a memoized child depends on a stable reference, or the computation is expensive and you measured it. Unnecessary memoization has its own cost (the comparison, the extra closure) and it obscures what the component is actually doing.

---

## Forms

Controlled components whenever validation matters. Share schemas with the server via `@sinclair/typebox` (the project's schema tool) so client and server agree by construction.

Defer form libraries (React Hook Form, etc.) until a form has ≥5 fields or cross-field rules. Revisit at that point — don't pre-adopt for the sake of consistency.

---

## Testing

- React Testing Library + `@testing-library/user-event`.
- Query by role / label / text. `data-testid` is the last resort for genuinely unnameable elements.
- Wrap in `<QueryClientProvider>` via `test/helpers/with-query-client.tsx`. The helper builds a test client with `retry: false` and `gcTime: 0` so tests don't share cache state.
- Stub data via an `ApiClient` mock — the same seam the production tree uses. One injection seam, not two.
- No snapshot tests of component trees. Assert on what the user sees.

---

## Anti-patterns

- `useEffect` + `cancelled` flag to fetch → you reimplement retry, dedup, cache, and staleness badly. Use `useQuery`.
- `useState` holding fetched server data → the cache belongs in the query client so every view sees the same thing.
- Hand-written `['runs']` key at a call site → factory-only, so invalidation can't drift.
- `useMemo` around a string literal or a cheap `.filter()` → the memoization costs more than the work.
- Route file >300 lines → split. The route should read as a sequence of hook calls + layout.
- `any` in props → type it, or take `unknown` and narrow at the boundary.
- Inline arrow props passed to memoized children on hot rows → hoist so the memo actually holds.
- Snapshot tests of rendered trees → break on harmless markup changes, never catch real bugs.

---

## UI primitives

Four load-bearing components that every surface in `packages/web` reaches for. If you're hand-rolling the shape one of these provides, reach for the component instead.

| Component | File | When to use |
|---|---|---|
| `<PageTitle>` | `components/ui/page-title.tsx` | Exactly one per route — renders `<h1>` at `text-sw-lg`. Optional `action` slot for per-page controls. |
| `<SectionTitle>` | `components/ui/section-title.tsx` | Per bento section inside a route ("Inbox", "Running", "Activity") — renders `<h2>` at `text-sw-md`. Optional `action` slot for "View all →" links. |
| `<EmptyState>` | `components/ui/empty-state.tsx` | Whenever a section has nothing to show. `density="default"` for a full bento card; `density="compact"` for the calm one-liner strip (e.g. "All clear"). |
| `<Card>` | `components/ui/card.tsx` | Bento surface for data cells (stats tiles, detail panels). Owns surface bg + hairline; don't apply those tokens yourself. |

Other component directories to be aware of:

- `components/ui/` — shadcn-generated primitives (`Badge`, `Button`, `Dialog`, etc.). Token layer: shadcn vars. Don't add product logic here.
- `components/ai-elements/` — AI chat interface elements (`Conversation`, `Message`, `PromptInput`, etc.).
- `components/` root — product components (`RunRow`, `GlobalFeed`, `Inbox`, `AppShell`, etc.). Token layer: `sw-*`.

Design tokens and the rule for mixing layers are in `.agents/skills/design/SKILL.md`. Pair that skill with this one for any style decision.

---

## When principles conflict

Simplicity wins. Default answer to "should I add another hook/memo/library/abstraction" is no.
