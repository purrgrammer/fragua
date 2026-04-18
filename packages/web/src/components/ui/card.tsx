import type * as React from "react";

import { cn } from "@/lib/utils";

function Card({ className, size = "default", ...props }: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        // structure: bento cell, content-driven height
        "group/card flex flex-col overflow-hidden",
        // surface + hairline (no ring, no shadow)
        "bg-[var(--sw-surface)] text-[var(--sw-text)]",
        "border border-[var(--sw-border)] rounded-[var(--sw-radius-card)]",
        // padding & gap — spacing.3 default, .2 for sm; consistent across slots
        "py-[var(--sw-space-3)] gap-[var(--sw-space-3)]",
        "data-[size=sm]:py-[var(--sw-space-2)] data-[size=sm]:gap-[var(--sw-space-2)]",
        // footer flush-bottom when present (border-t handles separation)
        "has-data-[slot=card-footer]:pb-0",
        // image edges follow card radius
        "has-[>img:first-child]:pt-0",
        "*:[img:first-child]:rounded-t-[var(--sw-radius-card)]",
        "*:[img:last-child]:rounded-b-[var(--sw-radius-card)]",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start",
        "gap-[var(--sw-space-1)]",
        "px-[var(--sw-space-3)]",
        "has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        "has-data-[slot=card-description]:grid-rows-[auto_auto]",
        "[.border-b]:pb-[var(--sw-space-3)] [.border-b]:border-[var(--sw-border)]",
        className,
      )}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      // monospace inherited; weight 500 carries the heading. No size jump
      // between default and sm — hierarchy via weight + case, not size.
      className={cn("font-medium leading-[1.2] text-[var(--sw-text)]", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-description" className={cn("text-[var(--sw-muted)]", className)} {...props} />;
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-[var(--sw-space-3)]", className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      // Same surface as card; separation is the top hairline only — no
      // background-shade hierarchy. Padding consistent with body cells.
      className={cn(
        "flex items-center",
        "border-t border-[var(--sw-border)]",
        "px-[var(--sw-space-3)] py-[var(--sw-space-3)]",
        "group-data-[size=sm]/card:px-[var(--sw-space-2)] group-data-[size=sm]/card:py-[var(--sw-space-2)]",
        className,
      )}
      {...props}
    />
  );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
