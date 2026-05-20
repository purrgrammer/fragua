// Persistent left-rail navigation. Hosts the "swarm" wordmark in the
// header, two grouped nav sections (Operate / Build) in the content
// slot, and the connection-status badge in the footer.
//
// The two-group split separates surfaces that observe or steer a
// running system (Watchtower, Inbox, Runs, Schedules, Analytics) from surfaces
// that author or configure it (Projects, Workflows, Providers).
//
// The badge moved out of the old `App.tsx` header into the sidebar
// footer so the topbar can be a clean breadcrumb-only surface; the
// status indicator is still always visible (and gets a tooltip when
// the rail is collapsed to the icon-only width). Status itself is
// read from `HealthContext` — see `App.tsx` for the publisher.

import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  BookOpen,
  Bot,
  CalendarClock,
  Cpu,
  Drone,
  FolderGit2,
  Inbox as InboxIcon,
  ListChecks,
  TowerControl,
  Workflow,
} from "lucide-react";
import { NavLink, useMatch } from "react-router-dom";
import { queries } from "../lib/queries.ts";
import { useHealth } from "../types/health.ts";
import { HealthBadge } from "./HealthBadge.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "./ui/sidebar.tsx";

const OPERATE_NAV = [
  { to: "/", label: "Watchtower", icon: TowerControl, end: true },
  { to: "/inbox", label: "Inbox", icon: InboxIcon, end: false },
  { to: "/runs", label: "Runs", icon: ListChecks, end: false },
  { to: "/schedules", label: "Schedules", icon: CalendarClock, end: false },
  { to: "/analytics", label: "Analytics", icon: BarChart3, end: false },
] as const;

const BUILD_NAV = [
  { to: "/projects", label: "Projects", icon: FolderGit2, end: false },
  { to: "/workflows", label: "Workflows", icon: Workflow, end: false },
  { to: "/skills", label: "Skills", icon: BookOpen, end: false },
  { to: "/agents", label: "Agents", icon: Bot, end: false },
  { to: "/providers", label: "Providers", icon: Cpu, end: false },
] as const;

type NavEntry = (typeof OPERATE_NAV)[number] | (typeof BUILD_NAV)[number];

export function AppSidebar(): JSX.Element {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <NavLink
          to="/"
          className="flex h-8 items-center gap-2 px-1 font-heading text-lg font-semibold tracking-tight"
          data-testid="sidebar-wordmark"
        >
          {/* Plain icon — no filled square — keeps the brand visible at
              the icon-only width without a heavy block in the rail. */}
          <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center text-sw-text">
            <Drone className="size-5" />
          </span>
          <span className="truncate group-data-[collapsible=icon]/sidebar:hidden">swarm</span>
        </NavLink>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Operate</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {OPERATE_NAV.map((entry) => (
                <NavItem key={entry.to} entry={entry} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Build</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {BUILD_NAV.map((entry) => (
                <NavItem key={entry.to} entry={entry} />
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

const INBOX_FILTER = { inbox: "pending" as const, order: "oldest" as const };

/** Count badge for the Inbox nav row. Queries the same cache slot as
 * WorktreeInbox so there is exactly one fetch for both consumers. */
function InboxPendingBadge(): JSX.Element | null {
  const { state } = useSidebar();
  const { data } = useQuery(queries.runs.list(INBOX_FILTER));
  const count = data?.length ?? 0;
  if (count === 0 || state === "collapsed") return null;
  return (
    <span
      data-testid="nav-inbox-pending-count"
      className="ml-auto shrink-0 rounded-full bg-[color-mix(in_oklch,var(--sw-accent-warn)_15%,transparent)] px-1.5 py-0.5 text-[length:var(--sw-text-xs)] font-medium text-[var(--sw-accent-warn)] tabular-nums"
    >
      {count}
    </span>
  );
}

/**
 * One nav row. We compute `isActive` via `useMatch` rather than the
 * `NavLink` render prop because `SidebarMenuButton`'s active-state
 * styling keys off its own `isActive` *prop* (which forwards to a
 * `data-active` attribute on the rendered element). Reading active
 * from NavLink's render prop alone would only decorate a descendant
 * span — the button chrome itself would never change.
 */
function NavItem({ entry }: { entry: NavEntry }): JSX.Element {
  const { to, label, icon: Icon, end } = entry;
  const match = useMatch({ path: to, end });
  const isActive = match !== null;
  const isInbox = to === "/inbox";
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip={label} isActive={isActive}>
        <NavLink
          to={to}
          end={end}
          data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
          aria-current={isActive ? "page" : undefined}
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            <Icon className="size-4 shrink-0" />
            <span className="truncate group-data-[collapsible=icon]/sidebar:hidden">{label}</span>
            {isInbox && <InboxPendingBadge />}
          </span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
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
    const tone =
      status === "connected"
        ? "bg-sw-accent-success"
        : status === "error"
          ? "bg-sw-accent-error"
          : status === "no-daemon"
            ? "bg-sw-accent-warn"
            : "bg-sw-accent-idle";
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
