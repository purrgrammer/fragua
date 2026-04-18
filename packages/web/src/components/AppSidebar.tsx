// Persistent left-rail navigation. Hosts the "swarm" wordmark in the
// header, the Home / Workflows / Pipelines / Settings entries in the
// content slot, and the connection-status badge in the footer.
//
// The badge moved out of the old `App.tsx` header into the sidebar
// footer so the topbar can be a clean breadcrumb-only surface; the
// status indicator is still always visible (and gets a tooltip when
// the rail is collapsed to the icon-only width). Status itself is
// read from `HealthContext` — see `App.tsx` for the publisher.

import { BookOpen, Drone, Home, ListChecks, Settings, Workflow } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useHealth } from "../types/health.ts";
import { HealthBadge } from "./HealthBadge.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar.tsx";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/workflows", label: "Workflows", icon: Workflow, end: false },
  { to: "/pipelines", label: "Pipelines", icon: ListChecks, end: false },
  { to: "/skills", label: "Skills", icon: BookOpen, end: false },
  { to: "/settings", label: "Settings", icon: Settings, end: false },
] as const;

export function AppSidebar(): JSX.Element {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div
          className="flex h-8 items-center gap-2 px-1 font-heading text-lg font-semibold tracking-tight"
          data-testid="sidebar-wordmark"
        >
          {/* Plain icon — no filled square — keeps the brand visible at
              the icon-only width without a heavy block in the rail. */}
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center text-foreground">
            <Drone className="size-5" />
          </span>
          <span className="truncate group-data-[collapsible=icon]/sidebar:hidden">swarm</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map(({ to, label, icon: Icon, end }) => (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton asChild tooltip={label}>
                    <NavLink to={to} end={end} data-testid={`nav-${label.toLowerCase()}`}>
                      {({ isActive }) => <NavInner Icon={Icon} label={label} isActive={isActive} />}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarStatusBadge />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

interface NavInnerProps {
  Icon: typeof Home;
  label: string;
  isActive: boolean;
}

/**
 * `NavLink` children-as-function gets `isActive`; we forward it both as
 * a `data-active` attribute (so `SidebarMenuButton`'s `data-[active=...]`
 * styling lights up) and as `aria-current` for accessibility.
 */
function NavInner({ Icon, label, isActive }: NavInnerProps): JSX.Element {
  return (
    <span
      className="flex w-full min-w-0 items-center gap-2"
      data-active={isActive ? "true" : undefined}
      aria-current={isActive ? "page" : undefined}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate group-data-[collapsible=icon]/sidebar:hidden">{label}</span>
    </span>
  );
}

function SidebarStatusBadge(): JSX.Element {
  const { state } = useSidebar();
  const { status, error } = useHealth();
  // Collapsed rail: render the dot only — the full badge text would
  // overflow the icon-width column. Expanded: render the existing
  // HealthBadge component so the styling stays in lockstep with the
  // old top-bar version (single source of truth).
  if (state === "collapsed") {
    const tone = status === "connected" ? "bg-emerald-500" : status === "error" ? "bg-rose-500" : "bg-slate-400";
    return (
      <div
        data-testid="sidebar-health-dot"
        data-status={status}
        title={error ?? status}
        className="flex h-7 w-full items-center justify-center"
      >
        <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${tone}`} />
      </div>
    );
  }
  return <HealthBadge status={status} error={error} />;
}
