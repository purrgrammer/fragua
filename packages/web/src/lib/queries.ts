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
        refetchInterval: 5_000,
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
};
