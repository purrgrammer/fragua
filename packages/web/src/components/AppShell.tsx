// Persistent layout: sidebar on the left, breadcrumb header + routed
// `<Outlet />` on the right. Wraps every page so the chrome (sidebar,
// breadcrumb, connection status) stays mounted across navigations and
// only the content swaps.
//
// Connection status is read from `HealthContext` (App is the
// publisher). Pulling it via context — instead of threading it
// through router options — means the sidebar badge re-renders on
// status flips even when tests inject their own router.
//
// The breadcrumb is derived from the current `pathname` — see
// `crumbsFor()` below. We deliberately don't read route data from
// `useMatches()` because the route table doesn't carry handle metadata
// today; deriving from the URL is two lines of code and keeps the
// route definitions free of breadcrumb-specific config.

import { Outlet, useLocation, useParams } from "react-router-dom";
import { AppSidebar } from "./AppSidebar.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb.tsx";
import { Separator } from "./ui/separator.tsx";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./ui/sidebar.tsx";

export function AppShell(): JSX.Element {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header data-testid="app-shell-header" className="flex h-14 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <RouteBreadcrumb />
        </header>
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

interface Crumb {
  label: string;
  href?: string;
}

function RouteBreadcrumb(): JSX.Element {
  const { pathname } = useLocation();
  const params = useParams();
  const crumbs = crumbsFor(pathname, params);
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={`${c.label}-${i}`} className="contents">
              <BreadcrumbItem>
                {last || !c.href ? (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={c.href}>{c.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator />}
            </span>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * Map a URL pathname to a breadcrumb trail. Exported for tests so we
 * don't need to mount the whole router to verify the labels.
 */
export function crumbsFor(pathname: string, params: Record<string, string | undefined>): Crumb[] {
  if (pathname === "/" || pathname === "") return [{ label: "Home" }];
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ label: "Home", href: "/" }];
  if (segments[0] === "workflows") {
    crumbs.push({ label: "Workflows" });
    return crumbs;
  }
  if (segments[0] === "settings") {
    crumbs.push({ label: "Settings" });
    return crumbs;
  }
  if (segments[0] === "pipelines") {
    if (segments.length === 1) {
      crumbs.push({ label: "Pipelines" });
      return crumbs;
    }
    crumbs.push({ label: "Pipelines", href: "/pipelines" });
    const id = params["id"] ?? segments[1] ?? "";
    crumbs.push({ label: id.length > 8 ? id.slice(0, 8) : id });
    return crumbs;
  }
  // Unknown route — just label it from the first segment.
  crumbs.push({ label: segments[0] ?? "Unknown" });
  return crumbs;
}
