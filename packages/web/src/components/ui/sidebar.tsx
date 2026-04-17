// shadcn/ui — Sidebar.
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
          className={cn("group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar", className)}
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
        "group/sidebar relative flex h-svh shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-[width] duration-200 ease-linear",
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
        "absolute inset-y-0 right-0 z-20 hidden w-2 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-px hover:after:bg-sidebar-border sm:flex",
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
      className={cn("relative flex min-h-svh flex-1 flex-col bg-background", className)}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return <div data-slot="sidebar-header" className={cn("flex flex-col gap-2 p-2", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return <div data-slot="sidebar-footer" className={cn("mt-auto flex flex-col gap-2 p-2", className)} {...props} />;
}

export function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>): JSX.Element {
  return (
    <Separator data-slot="sidebar-separator" className={cn("mx-2 w-auto bg-sidebar-border", className)} {...props} />
  );
}

export function SidebarContent({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]/sidebar:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div data-slot="sidebar-group" className={cn("relative flex w-full min-w-0 flex-col p-2", className)} {...props} />
  );
}

export function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return (
    <div
      data-slot="sidebar-group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-none transition-[margin,opacity] duration-200 ease-linear group-data-[collapsible=icon]/sidebar:-mt-8 group-data-[collapsible=icon]/sidebar:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">): JSX.Element {
  return <div data-slot="sidebar-group-content" className={cn("w-full text-sm", className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">): JSX.Element {
  return <ul data-slot="sidebar-menu" className={cn("flex w-full min-w-0 flex-col gap-1", className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">): JSX.Element {
  return <li data-slot="sidebar-menu-item" className={cn("group/menu-item relative", className)} {...props} />;
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground group-data-[collapsible=icon]/sidebar:size-8! group-data-[collapsible=icon]/sidebar:p-2! [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "",
      },
      size: {
        default: "h-8",
        sm: "h-7 text-xs",
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
