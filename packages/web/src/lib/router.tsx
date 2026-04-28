// Minimal router wrapper around `react-router-dom`'s data-router API.
//
// Layout: every concrete route nests under the `AppShell` so the sidebar +
// breadcrumb header stay mounted and only the routed `<Outlet />` swaps.

import { createBrowserRouter, type RouteObject } from "react-router-dom";
import { AppShell } from "../components/AppShell.tsx";
import { Home } from "../routes/Home.tsx";
import { InboxPage } from "../routes/Inbox.tsx";
import { ProviderDetail } from "../routes/ProviderDetail.tsx";
import { Providers } from "../routes/Providers.tsx";
import { RunDetail } from "../routes/RunDetail.tsx";
import { RunsList } from "../routes/RunsList.tsx";
import { WorkflowDetail } from "../routes/WorkflowDetail.tsx";
import { Workflows } from "../routes/Workflows.tsx";

export function createRoutes(): RouteObject[] {
  return [
    {
      path: "/",
      element: <AppShell />,
      children: [
        { index: true, element: <Home /> },
        { path: "inbox", element: <InboxPage /> },
        { path: "workflows", element: <Workflows /> },
        { path: "workflows/:name", element: <WorkflowDetail /> },
        { path: "providers", element: <Providers /> },
        { path: "providers/:name", element: <ProviderDetail /> },
        { path: "runs", element: <RunsList /> },
        // Run detail is one component regardless of which tab is
        // selected — the `:view` param (conversation | events | graph |
        // steps) drives which pane renders. Bare `/runs/:id` redirects
        // to `/runs/:id/conversation` (handled inside RunDetail).
        { path: "runs/:id", element: <RunDetail /> },
        { path: "runs/:id/:view", element: <RunDetail /> },
        { path: "*", element: <NotFound /> },
      ],
    },
    { path: "*", element: <AppShell /> },
  ];
}

export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(createRoutes());
}

function NotFound(): JSX.Element {
  return (
    <div className="p-8 text-center text-sw-muted">
      <h2 className="text-lg font-semibold mb-2">Not found</h2>
      <p className="text-sm">That page doesn't exist.</p>
    </div>
  );
}
