// shadcn/ui — Sidebar (Swarm design language).
//
// Vendored, slimmed-down adaptation of the canonical shadcn `sidebar`
// primitive. The full upstream version ships ~600 lines covering
// off-canvas mobile drawers, floating variants, multi-sidebar layouts,
// etc.; we keep just the surface the swarm dashboard actually uses:
//
//   - `SidebarProvider`     — context + cookie-backed collapsed state
//   - `Sidebar`             — `collapsible="icon"` rail, no off-canvas
//   - `SidebarTrigger`      — header toggle button
//   - `SidebarRail`         — narrow click-target on the sidebar's edge
//   - `SidebarInset`        — the routed-page container next to it
//   - `SidebarHeader/Content/Footer/Group/...` — layout slots
//   - `SidebarMenu/Button`  — nav rows w/ tooltip-when-collapsed
//
// Persistence: `SidebarProvider` writes `sidebar:state=true|false` to
// `document.cookie` on every toggle. We *do* read it back on mount so a
// reload preserves the user's choice (one of the load-bearing reasons
// to vendor shadcn here at all). Cookie name + max-age match upstream.
//
// Keyboard: `⌘ + b` (mac) / `Ctrl + b` (everywhere else) toggles the
// sidebar — wired in `SidebarProvider`. Same shortcut shadcn ships
// upstream so existing muscle memory carries over.
//
// Skill citations (.agents/skills/design/SKILL.md):
//   § Color               — only --sw-* tokens. shadcn aliases
//                           (bg-sidebar, text-sidebar-foreground,
//                           bg-sidebar-accent, bg-sidebar-accent-fg,
//                           border-sidebar-border, ring-sidebar-ring,
//                           bg-background) replaced. Active-row
//                           highlight uses --sw-bg (one-notch contrast
//                           against the --sw-surface rail), matching
//                           dropdown/select/command. Accent state
//                           tokens are *not* used for nav selection —
//                           "Accents reserved for state — not branding".
//   § Themes              — both light + dark resolve through the same
//                           --sw-* tokens; no auto-inversion, no
//                           opacity-tinted colors (text-…/70 dropped
//                           in favour of --sw-muted).
//   § Borders & elevation — "1px only"; "Radius: 2px default … 0px
//                           for table rows and dense stacks". Nav rows
//                           are a dense stack, so menu buttons +
//                           group labels use --sw-radius-default (2px).
//                           No box-shadow anywhere (global reset).
//   § Layout              — rail separator is a 1px hairline
//                           (--sw-border) — never a background shade.
//                           Padding snaps to --sw-space-* tokens.
//   § Typography          — sizes from --sw-text-* scale. Group label
//                           tier is xs (11px) muted UPPERCASE +
//                           0.06em tracking — the one place tracking
//                           is permitted. Active row is differentiated
//                           by weight (500) + subtle bg, not size.
//   § Spacing             — token scale only (4/8/12). gap-1/2,
//                           p-2, mx-2 mapped to --sw-space-1/2.
//   § Motion              — width morph and label fade use
//                           --sw-duration-enter (200ms) ease-out per
//                           the "Drawer / panel enter-exit" Motion
//                           table row — *not* `linear` (which the
//                           skill reserves for constant-motion
//                           indicators, "never for color"). Color +
//                           bg shifts on hover use --sw-duration-hover
//                           (120ms ease). The off-spec
//                           transition-[width,height,padding] on
//                           menu rows is dropped: the only animated
//                           property is the rail's `width`, which
//                           covers the visual change, and
//                           "Animations touch only `transform` and
//                           `opacity`" leaves padding/height jumps
//                           instantaneous.

"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeft } from "lucide-react";
import { Slot as SlotPrimitive } from "radix-ui";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const SIDEBAR_COOKIE_NAME = "sidebar:state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_KEYBOARD_SHORTCUT = "b";
const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_ICON = "3rem";

type SidebarContextValue = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a <SidebarProvider>.");
  return ctx;
}

export interface SidebarProviderProps extends React.ComponentProps<"div"> {
  /** Uncontrolled initial state. Ignored when `open` is supplied. */
  defaultOpen?: boolean;
  /** Controlled state. Pair with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  className,
  style,
  children,
  ...props
}: SidebarProviderProps): JSX.Element {
  const [internalOpen, setInternalOpen] = React.useState<boolean>(() => {
    // Read cookie once on first render so reloads preserve the user's
    // last collapsed state. Falls through to `defaultOpen` server-side
    // and on first-ever load.
    if (typeof document === "undefined") return defaultOpen;
    const match = document.cookie.match(/(?:^|; )sidebar:state=(true|false)/);
    if (!match) return defaultOpen;
    return match[1] === "true";
  });

  const open = openProp ?? internalOpen;
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (onOpenChange) onOpenChange(next);
      else setInternalOpen(next);
      if (typeof document !== "undefined") {
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${next}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
      }
    },
    [onOpenChange],
  );

  const toggleSidebar = React.useCallback(() => setOpen(!open), [open, setOpen]);

  // ⌘+b / Ctrl+b global toggle. Match shadcn upstream so muscle
  // memory carries over.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === SIDEBAR_KEYBOARD_SHORTCUT && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleSidebar();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const state: "expanded" | "collapsed" = open ? "expanded" : "collapsed";
  const value = React.useMemo<SidebarContextValue>(
    () => ({ state, open, setOpen, toggleSidebar }),
    [state, open, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          data-state={state}
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn("group/sidebar-wrapper flex min-h-svh w-full bg-[var(--sw-bg)]", className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

export interface SidebarProps extends React.ComponentProps<"div"> {
  /**
   * `"icon"` collapses to a narrow rail of icons (the swarm default —
   * the dashboard always wants *some* sidebar real estate visible).
   * `"none"` opts out of collapsing.
   */
  collapsible?: "icon" | "none";
}

export function Sidebar({ collapsible = "icon", className, children, ...props }: SidebarProps): JSX.Element {
  const { state } = useSidebar();
  return (
    <div
      data-slot="sidebar"
      data-state={state}
      data-collapsible={collapsible === "none" ? "" : state === "collapsed" ? collapsible : ""}
      className={cn(
        // Width animates between full and icon-only widths driven by
        // CSS variables defined on the wrapper. Hidden overflow keeps
        // labels from spilling during the transition.
        // Surface = --sw-surface (one notch off bg, the standard panel
        // tone). Hairline right edge — "sections separated by a
        // hairline" (§ Layout).
        "group/sidebar relative flex h-svh shrink-0 flex-col",
        "bg-[var(--sw-surface)] text-[var(--sw-text)]",
        "border-r border-[var(--sw-border)]",
        // Motion: 200ms ease-out (§ Motion, Drawer / panel enter-exit).
        // Replaces `ease-linear`, which the skill reserves for constant-
        // motion indicators only.
        "transition-[width] duration-[var(--sw-duration-enter)] ease-out",
        collapsible === "none"
          ? "w-(--sidebar-width)"
          : state === "expanded"
            ? "w-(--sidebar-width)"
            : "w-(--sidebar-width-icon)",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>): JSX.Element {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn("size-7", className)}
      onClick={(e) => {
        onClick?.(e);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeft />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
}

export function SidebarRail({ className, ...props }: React.ComponentProps<"button">): JSX.Element {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-slot="sidebar-rail"
      aria-label="Toggle sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle sidebar"
      className={cn(
        // Hairline drag-handle. Hover surfaces the 1px line in
        // --sw-border. No `transition-all ease-linear` — only the
        // hover color shift is animated, at --sw-duration-hover.
        "absolute inset-y-0 right-0 z-20 hidden w-2 -translate-x-1/2 sm:flex",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-px",
        "after:transition-colors after:duration-[var(--sw-duration-hover)] after:ease-[ease]",
        "hover:after:bg-[var(--sw-border)]",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarInset({ className, ...props }: React.ComponentProps<"main">): JSX.Element {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn("relative flex min-h-svh flex-1 flex-col bg-[var(--sw-bg)]", className)}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="sidebar-header"
      className={cn("flex flex-col gap-[var(--sw-space-2)] p-[var(--sw-space-2)]", className)}
      {...props}
    />
  );
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("mt-auto flex flex-col gap-[var(--sw-space-2)] p-[var(--sw-space-2)]", className)}
      {...props}
    />
  );
}

export function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>): JSX.Element {
  return (
    <Separator
      data-slot="sidebar-separator"
      className={cn("mx-[var(--sw-space-2)] w-auto bg-[var(--sw-border)]", className)}
      {...props}
    />
  );
}

export function SidebarContent({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-[var(--sw-space-2)] overflow-auto",
        "group-data-[collapsible=icon]/sidebar:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col p-[var(--sw-space-2)]", className)}
      {...props}
    />
  );
}

export function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        // Group label tier — UPPERCASE + 0.06em tracking + muted, the
        // one place tracking is permitted (§ Typography, "section
        // labels and column headers"). Matches dropdown/select/command.
        "flex h-8 shrink-0 items-center px-[var(--sw-space-2)] outline-none",
        "text-[length:var(--sw-text-xs)] font-medium uppercase tracking-[0.06em]",
        "text-[var(--sw-muted)]",
        "rounded-[var(--sw-radius-default)]",
        // Collapse: fade out to 0 + slide above the cell. 200ms
        // ease-in-out per the on-screen morph row of the Motion table
        // (replaces ease-linear).
        "transition-[margin,opacity] duration-[var(--sw-duration-enter)] ease-in-out",
        "group-data-[collapsible=icon]/sidebar:-mt-8 group-data-[collapsible=icon]/sidebar:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="sidebar-group-content"
      className={cn("w-full text-[length:var(--sw-text-sm)]", className)}
      {...props}
    />
  );
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">): JSX.Element {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-[var(--sw-space-1)]", className)}
      {...props}
    />
  );
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">): JSX.Element {
  return <li data-slot="sidebar-menu-item" className={cn("group/menu-item relative", className)} {...props} />;
}

const sidebarMenuButtonVariants = cva(
  cn(
    // structure
    "peer/menu-button flex w-full items-center select-none outline-none",
    "gap-[var(--sw-space-2)] p-[var(--sw-space-2)]",
    "text-left text-[length:var(--sw-text-sm)]",
    // 2px default radius — nav rows are a dense stack, not a card.
    "rounded-[var(--sw-radius-default)]",
    // Hover/focus: --sw-bg gives one-notch contrast against the
    // surrounding --sw-surface rail (matches dropdown/select/command).
    // 120ms ease color shift per § Motion.
    "transition-[background-color,color] duration-[var(--sw-duration-hover)] ease-[ease]",
    "hover:bg-[var(--sw-bg)] hover:text-[var(--sw-text)]",
    "focus-visible:ring-1 focus-visible:ring-[var(--sw-border)]",
    "active:bg-[var(--sw-bg)] active:text-[var(--sw-text)]",
    // Disabled
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-disabled:pointer-events-none aria-disabled:opacity-50",
    // Active row — selection state, NOT a status accent. Weight 500 +
    // subtle --sw-bg fill is the discriminator (§ Typography:
    // "Hierarchy via weight, case, and spacing — never size jumps").
    "data-[active=true]:bg-[var(--sw-bg)] data-[active=true]:text-[var(--sw-text)]",
    "data-[active=true]:font-medium",
    // Collapsed rail: square 32px hit target, no padding overrides.
    "group-data-[collapsible=icon]/sidebar:size-8! group-data-[collapsible=icon]/sidebar:p-[var(--sw-space-2)]!",
    // Icon sizing — neutral, no decorative tint.
    "[&>svg]:size-4 [&>svg]:shrink-0",
    "overflow-hidden",
  ),
  {
    variants: {
      variant: {
        default: "",
      },
      size: {
        default: "h-8",
        sm: "h-7 text-[length:var(--sw-text-xs)]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface SidebarMenuButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof sidebarMenuButtonVariants> {
  asChild?: boolean;
  isActive?: boolean;
  /**
   * Tooltip shown only when the sidebar is collapsed to its icon rail.
   * Pass the same string the visible label would use; we hide the
   * label via CSS in the collapsed state, so without a tooltip the
   * nav becomes a row of unlabeled icons.
   */
  tooltip?: string;
}

export const SidebarMenuButton = React.forwardRef<HTMLButtonElement, SidebarMenuButtonProps>(function SidebarMenuButton(
  { asChild, isActive, variant, size, tooltip, className, children, ...props },
  ref,
) {
  const Comp = asChild ? SlotPrimitive.Slot : "button";
  const { state } = useSidebar();
  const button = (
    <Comp
      // biome-ignore lint/suspicious/noExplicitAny: Slot's ref typing is permissive by design.
      ref={ref as any}
      data-slot="sidebar-menu-button"
      data-active={isActive ? "true" : undefined}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    >
      {children}
    </Comp>
  );
  if (!tooltip || state === "expanded") return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
});
