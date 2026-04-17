// shadcn/ui — Breadcrumb.
//
// Vendored from the canonical shadcn copy. We render the breadcrumb in
// the `AppShell` header, derived from the current route. Components are
// pure styling shells around semantic `<nav>` / `<ol>` markup so screen
// readers and search engines see an actual breadcrumb, not a sea of
// divs.

import { ChevronRight, MoreHorizontal } from "lucide-react";
import { Slot as SlotPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
  return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
  return (
    <ol
      data-slot="breadcrumb-list"
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-sm break-words text-muted-foreground sm:gap-2.5",
        className,
      )}
      {...props}
    />
  );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
  return <li data-slot="breadcrumb-item" className={cn("inline-flex items-center gap-1.5", className)} {...props} />;
}

function BreadcrumbLink({ asChild, className, ...props }: React.ComponentProps<"a"> & { asChild?: boolean }) {
  const Comp = asChild ? SlotPrimitive.Slot : "a";
  return (
    <Comp data-slot="breadcrumb-link" className={cn("transition-colors hover:text-foreground", className)} {...props} />
  );
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-page"
      // role/aria-disabled/aria-current together signal "this is the
      // current page in the trail" to assistive tech without making the
      // text look or behave like a link. `tabIndex={-1}` keeps it
      // programmatically focusable (so the role="link" is reachable to
      // AT that walks the focus tree) while staying out of the normal
      // tab order — the current page isn't a navigation target.
      role="link"
      aria-disabled="true"
      aria-current="page"
      tabIndex={-1}
      className={cn("font-normal text-foreground", className)}
      {...props}
    />
  );
}

function BreadcrumbSeparator({ children, className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="breadcrumb-separator"
      role="presentation"
      aria-hidden="true"
      className={cn("[&>svg]:size-3.5", className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  );
}

function BreadcrumbEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="breadcrumb-ellipsis"
      role="presentation"
      aria-hidden="true"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontal className="size-4" />
      <span className="sr-only">More</span>
    </span>
  );
}

export {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
};
