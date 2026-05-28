import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        [
          // structure
          "fixed inset-0 isolate z-50",

          // scrim: --sw-text at low opacity reads as a designed dim in
          // both themes (inverts naturally), no hex literal. /40 carries
          // the elevation work — the design rule is scrim + hairline, and
          // /10 was too faint to separate the drawer from same-surface
          // cards beneath it.
          "bg-[var(--sw-text)]/40",
          "supports-backdrop-filter:backdrop-blur-xs",

          // motion: paired with content — 200ms ease-out, fade only
          "duration-[var(--sw-duration-enter)] ease-out",
          "data-open:animate-in data-open:fade-in-0",
          "data-closed:animate-out data-closed:fade-out-0",
        ].join(" "),
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          [
            // structure: centered, content-sized
            "fixed top-1/2 left-1/2 z-50 grid -translate-x-1/2 -translate-y-1/2",
            "w-full max-w-[calc(100%-2rem)] sm:max-w-sm",
            "gap-[var(--sw-space-3)] p-[var(--sw-space-4)]",

            // surface + hairline (no shadow, no ring elevation)
            "bg-[var(--sw-surface)] text-[var(--sw-text)]",
            "border border-[var(--sw-border)]",
            "rounded-[var(--sw-radius-card)]",

            // typography: sm body (mono inherited)
            "text-[length:var(--sw-text-sm)]",

            // focus: outline already managed by primitive
            "outline-none",

            // motion: paired enter/exit — fade only. Zoom removed
            // (decorative). Same easing/duration as overlay.
            "duration-[var(--sw-duration-enter)] ease-out",
            "data-open:animate-in data-open:fade-in-0",
            "data-closed:animate-out data-closed:fade-out-0",
          ].join(" "),
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-[var(--sw-space-2)] right-[var(--sw-space-2)]"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="dialog-header" className={cn("flex flex-col gap-[var(--sw-space-2)]", className)} {...props} />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        [
          // section separated by hairline — not a background shade.
          // Negative margins pull the rule to the card edge so the
          // 1px line aligns with the drawer outline (no double-stroke
          // because radius is small).
          "-mx-[var(--sw-space-4)] -mb-[var(--sw-space-4)] mt-[var(--sw-space-2)]",
          "px-[var(--sw-space-4)] pt-[var(--sw-space-3)] pb-[var(--sw-space-4)]",
          "border-t border-[var(--sw-border)]",
          "flex flex-col-reverse gap-[var(--sw-space-2)] sm:flex-row sm:justify-end",
        ].join(" "),
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        // md tier (15px) is the section-heading slot; weight 500 carries
        // hierarchy without size jumps. Mono inherited (font-heading
        // removed — sans is a §Typography anti-pattern).
        "text-[length:var(--sw-text-md)] font-medium leading-tight text-[var(--sw-text)]",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        [
          // sm body, muted secondary tier.
          "text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]",
          // Inline link affordance: underline at offset, hover lifts to
          // primary text. Token-only.
          "*:[a]:underline *:[a]:underline-offset-[3px]",
          "*:[a]:hover:text-[var(--sw-text)]",
        ].join(" "),
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
