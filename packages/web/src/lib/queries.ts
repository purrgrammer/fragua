import { queryOptions } from "@tanstack/react-query";
import type { JobStatus, ListRunsFilter } from "./api.ts";
import * as api from "./api.ts";

/** Canonicalize a `ListRunsFilter` so the same logical filter always
 * produces the same query-key fragment. */
function canonicalizeRunsFilter(filter?: ListRunsFilter): ListRunsFilter | null {
  if (!filter) return null;
  const out: ListRunsFilter = {};
  if (filter.status?.length) out.status = [...filter.status].sort();
  if (filter.order && filter.order !== "newest") out.order = filter.order;
  if (filter.limit !== undefined) out.limit = filter.limit;
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
    detail: (name: string) =>
      queryOptions({
        queryKey: [...queries.workflows.all(), "detail", name] as const,
        queryFn: () => api.getWorkflow(name),
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
