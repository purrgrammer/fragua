import { queryOptions } from "@tanstack/react-query";
import type { JobStatus } from "./api.ts";
import * as api from "./api.ts";

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
    list: () =>
      queryOptions({
        queryKey: [...queries.runs.all(), "list"] as const,
        queryFn: api.listRuns,
        // Poll infrequently; the list view is a dashboard, not a live
        // tail. Live state goes through the per-run SSE stream. Pause
        // when the query has errored so we don't hammer a dead server.
        refetchInterval: (q) => (q.state.error ? false : 15_000),
      }),
    detail: (id: string) =>
      queryOptions({
        queryKey: [...queries.runs.all(), "detail", id] as const,
        queryFn: () => api.getRun(id),
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
