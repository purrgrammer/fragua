// Minimal router wrapper around `react-router-dom`'s data-router API.
//
// Kept as a factory (not a top-level `const router = …`) so tests can mount
// their own router with `createMemoryRouter` and skip the browser-history
// dependency. `App.tsx` calls `createAppRouter()` once at startup.

import { createBrowserRouter, type RouteObject } from "react-router-dom";
import { PipelineDetail } from "../routes/PipelineDetail.tsx";
import { PipelinesList } from "../routes/PipelinesList.tsx";
import type { ApiClient } from "./api.ts";

export interface CreateRouterOptions {
  api: ApiClient;
}

/** Route table shared between browser and memory routers (tests use memory). */
export function createRoutes(opts: CreateRouterOptions): RouteObject[] {
  return [
    {
      path: "/",
      element: <PipelinesList api={opts.api} />,
    },
    {
      path: "/pipelines/:id",
      element: <PipelineDetail api={opts.api} />,
    },
    {
      path: "*",
      element: <NotFound />,
    },
  ];
}

export function createAppRouter(opts: CreateRouterOptions): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(createRoutes(opts));
}

function NotFound(): JSX.Element {
  return (
    <div className="p-8 text-center text-slate-600">
      <h2 className="text-lg font-semibold mb-2">Not found</h2>
      <p className="text-sm">That page doesn't exist.</p>
    </div>
  );
}
