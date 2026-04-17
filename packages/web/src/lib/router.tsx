// Minimal router wrapper around `react-router-dom`'s data-router API.
//
// Kept as a factory (not a top-level `const router = …`) so tests can
// mount their own router with `createMemoryRouter` and skip the
// browser-history dependency. `App.tsx` calls `createAppRouter()` once
// at startup.
//
// Layout: every concrete route nests under the `AppShell` so the
// sidebar + breadcrumb header stay mounted and only the routed
// `<Outlet />` swaps. Connection status reaches the sidebar via
// `HealthContext` (App provides), not through router options — that
// way the route tree stays stable across status flips.

import { createBrowserRouter, type RouteObject } from "react-router-dom";
import { AppShell } from "../components/AppShell.tsx";
import { Home } from "../routes/Home.tsx";
import { PipelineDetail } from "../routes/PipelineDetail.tsx";
import { PipelinesList } from "../routes/PipelinesList.tsx";
import { Settings } from "../routes/Settings.tsx";
import { Workflows } from "../routes/Workflows.tsx";
import type { ApiClient } from "./api.ts";

export interface CreateRouterOptions {
  api: ApiClient;
}

/** Route table shared between browser and memory routers (tests use memory). */
export function createRoutes(opts: CreateRouterOptions): RouteObject[] {
  return [
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <Home api={opts.api} /> },
        { path: "workflows", element: <Workflows api={opts.api} /> },
        { path: "pipelines", element: <PipelinesList api={opts.api} /> },
        { path: "pipelines/:id", element: <PipelineDetail api={opts.api} /> },
        { path: "settings", element: <Settings api={opts.api} /> },
        { path: "*", element: <NotFound /> },
      ],
    },
    // Top-level catch-all for absolute non-matches (e.g. happy-dom's
    // "blank" pathname under BrowserRouter). The App tests rely on
    // this — without it, an unmatched URL trips React Router's
    // default error boundary and tears down the layout we're about to
    // assert on.
    { path: "*", element: <AppShell /> },
  ];
}

export function createAppRouter(opts: CreateRouterOptions): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(createRoutes(opts));
}

function NotFound(): JSX.Element {
  return (
    <div className="p-8 text-center text-muted-foreground">
      <h2 className="text-lg font-semibold mb-2">Not found</h2>
      <p className="text-sm">That page doesn't exist.</p>
    </div>
  );
}
