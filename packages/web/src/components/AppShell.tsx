// Persistent layout: sidebar on the left, breadcrumb header + routed
// `<Outlet />` on the right. Wraps every page so the chrome (sidebar,
// breadcrumb, connection status) stays mounted across navigations and
// only the content swaps.
//
// Layout invariants (load-bearing — change with care):
//   - The shell is pinned to the viewport height. `SidebarProvider`
//     ships with `min-h-svh` by default, which lets it grow past the
//     viewport when inner content overflows — combined with
//     `body { overflow: hidden }` in globals.css, that clips the
//     bottom of the page and makes it unreachable. We override to
//     `h-svh` here so the wrapper is exactly viewport-tall, giving
//     the `overflow-auto` main region a bounded parent to scroll
//     inside of. `SidebarInset` gets `h-full` for the same reason.
//   - `min-w-0` on `SidebarInset` is the fix for flex children
//     refusing to shrink below their intrinsic content width, which
//     was letting wide tables push the sidebar off-screen.
//   - `<main>` is `flex-1 min-h-0 min-w-0 overflow-auto` so any
//     oversized page content scrolls inside the main region instead
//     of inflating the viewport. Pages that want to be full-bleed
//     (e.g. the run conversation) use `h-full` + `min-h-0`.
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
import { useHealth } from "../types/health.ts";
import { AppSidebar } from "./AppSidebar.tsx";
import { DaemonBanner } from "./DaemonBanner.tsx";
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

/**
 * Renders the daemon banner above the outlet when the health probe
 * reports no daemon. Skipped while the probe is still loading so the
 * banner doesn't flash on page load. Kept as a component (not inline)
 * so tests can assert on its presence/absence with a testid.
 */
function ShellDaemonBanner(): JSX.Element | null {
  const { status, daemon } = useHealth();
  if (status === "loading") return null;
  if (daemon !== undefined) return null;
  return <DaemonBanner />;
}

export function AppShell(): JSX.Element {
  return (
    <SidebarProvider className="h-svh">
      <AppSidebar />
      <SidebarInset className="h-full min-w-0">
        <header
          data-testid="app-shell-header"
          className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3"
        >
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <div className="min-w-0 flex-1 overflow-hidden">
            <RouteBreadcrumb />
          </div>
        </header>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-4">
          <ShellDaemonBanner />
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
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={`${c.label}-${i}`} className="contents">
              <BreadcrumbItem className="min-w-0">
                {last || !c.href ? (
                  <BreadcrumbPage className="truncate">{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={c.href} className="truncate">
                    {c.label}
                  </BreadcrumbLink>
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
  if (segments[0] === "runs") {
    if (segments.length === 1) {
      crumbs.push({ label: "Runs" });
      return crumbs;
    }
    crumbs.push({ label: "Runs", href: "/runs" });
    const id = params["id"] ?? segments[1] ?? "";
    crumbs.push({ label: id.length > 8 ? id.slice(0, 8) : id });
    return crumbs;
  }
  // Unknown route — just label it from the first segment.
  crumbs.push({ label: segments[0] ?? "Unknown" });
  return crumbs;
}
