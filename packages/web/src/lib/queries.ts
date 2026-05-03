import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import type { AnalyticsRequest, AnalyticsRunsRequest, JobStatus, ListRunsFilter } from "./api.ts";
import * as api from "./api.ts";

/** Canonicalize a `ListRunsFilter` so the same logical filter always
 * produces the same query-key fragment. */
function canonicalizeRunsFilter(filter?: ListRunsFilter): ListRunsFilter | null {
  if (!filter) return null;
  const out: ListRunsFilter = {};
  if (filter.status?.length) out.status = [...filter.status].sort();
  if (filter.order && filter.order !== "newest") out.order = filter.order;
  if (filter.limit !== undefined) out.limit = filter.limit;
  if (filter.cwd && filter.cwd.length > 0) out.cwd = filter.cwd;
  return Object.keys(out).length === 0 ? null : out;
}

export const queries = {
  health: () =>
    queryOptions({
      queryKey: ["health"] as const,
      queryFn: api.health,
      refetchInterval: 5_000,
      staleTime: 0,
    }),

  runs: {
    all: () => ["runs"] as const,
    /** Prefix key for every run-list variant. Pass to
     * `invalidateQueries` to refetch the unfiltered list AND every
     * filtered list (Inbox, Running) in one call. */
    lists: () => [...queries.runs.all(), "list"] as const,
    list: (filter?: ListRunsFilter) => {
      const canonical = canonicalizeRunsFilter(filter);
      return queryOptions({
        queryKey: [...queries.runs.lists(), canonical] as const,
        queryFn: () => api.listRuns(canonical ?? undefined),
        // No polling — `useGlobalEventStream` (mounted in App.tsx)
        // invalidates this query on every run-lifecycle SSE frame, so
        // the list refetches on actual state changes instead of every
        // 15 seconds regardless. Polling would be a strict regression
        // (latency + waste) once the SSE is wired.
      });
    },
    detail: (id: string) =>
      queryOptions({
        queryKey: [...queries.runs.all(), "detail", id] as const,
        queryFn: () => api.getRun(id),
      }),
    steps: (id: string) =>
      queryOptions({
        queryKey: [...queries.runs.all(), "steps", id] as const,
        queryFn: () => api.getRunSteps(id),
      }),
  },

  skills: {
    all: () => ["skills"] as const,
    list: () =>
      queryOptions({
        queryKey: [...queries.skills.all(), "list"] as const,
        queryFn: () => api.listSkills(),
      }),
    detail: (name: string) =>
      queryOptions({
        queryKey: [...queries.skills.all(), "detail", name] as const,
        queryFn: () => api.getSkill(name),
      }),
  },

  workflows: {
    all: () => ["workflows"] as const,
    list: () =>
      queryOptions({
        queryKey: [...queries.workflows.all(), "list"] as const,
        queryFn: api.listWorkflows,
      }),
    detail: (name: string, cwd?: string) =>
      queryOptions({
        // Per-source key: a name can point at different sources across
        // projects, so the cache must split on `cwd`.
        queryKey: [...queries.workflows.all(), "detail", name, cwd ?? "__global__"] as const,
        queryFn: () => api.getWorkflow(name, cwd !== undefined ? { cwd } : undefined),
      }),
  },

  projects: {
    all: () => ["projects"] as const,
    list: () =>
      queryOptions({
        queryKey: [...queries.projects.all(), "list"] as const,
        queryFn: api.listProjects,
        // No polling — `useGlobalEventStream` invalidates on run-lifecycle
        // SSE frames, which is what shifts a project's lastUpdatedAt /
        // runCount. Same SSE-driven freshness as the runs list.
      }),
  },

  jobs: {
    all: () => ["jobs"] as const,
    list: (filter?: { status?: JobStatus; limit?: number }) =>
      queryOptions({
        queryKey: [...queries.jobs.all(), "list", filter ?? null] as const,
        queryFn: () => api.listJobs(filter),
        refetchInterval: 2_000,
      }),
  },

  analytics: {
    all: () => ["analytics"] as const,
    /** Single batch payload powering every chart on /analytics. The
     *  cache key encodes the resolved window so the previous tick's
     *  data sticks around when the user toggles between windows. */
    summary: (req: AnalyticsRequest) =>
      queryOptions({
        queryKey: [...queries.analytics.all(), "summary", req] as const,
        queryFn: () => api.getAnalytics(req),
        // 30s tick keeps "Today" (and any auto-refreshing window) fresh
        // without hammering the SQL aggregation queries. Hidden tabs
        // pause via TanStack's default `refetchIntervalInBackground:false`.
        refetchInterval: 30_000,
        staleTime: 0,
        // When the user toggles windows the request key changes —
        // without `keepPreviousData` the tiles drop to undefined,
        // EMPTY_TOTALS substitutes in, and AnimatedNumber animates
        // every value down to 0 then back up. Keeping the previous
        // payload mounted means only the genuine deltas animate.
        placeholderData: keepPreviousData,
      }),
    /** Drill-down: paginated run list filtered to a chart-element slice. */
    drilldown: (req: AnalyticsRunsRequest) =>
      queryOptions({
        queryKey: [...queries.analytics.all(), "drilldown", req] as const,
        queryFn: () => api.getAnalyticsRuns(req),
        // Pinned by the slice the user clicked; refetches only when the
        // slice itself changes. No polling — the data is anchored.
        staleTime: 30_000,
      }),
  },

  providers: {
    all: () => ["providers"] as const,
    list: () =>
      queryOptions({
        queryKey: [...queries.providers.all(), "list"] as const,
        queryFn: api.listProviders,
        // No polling — the list is driven by explicit user actions
        // (add/rm/test) that invalidate it via useMutation.onSuccess.
        staleTime: 30_000,
      }),
    detail: (name: string) =>
      queryOptions({
        queryKey: [...queries.providers.all(), "detail", name] as const,
        queryFn: () => api.getProvider(name),
        staleTime: 30_000,
      }),
  },
};
