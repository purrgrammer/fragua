import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogAction({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return <AlertDialogPrimitive.Action data-slot="alert-dialog-action" {...props} />;
}

function AlertDialogCancel({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return <AlertDialogPrimitive.Cancel data-slot="alert-dialog-cancel" {...props} />;
}

function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        [
          "fixed inset-0 isolate z-50",
          "bg-[var(--sw-text)]/10",
          "supports-backdrop-filter:backdrop-blur-xs",
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

function AlertDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          [
            "fixed top-1/2 left-1/2 z-50 grid -translate-x-1/2 -translate-y-1/2",
            "w-full max-w-[calc(100%-2rem)] sm:max-w-sm",
            "gap-[var(--sw-space-3)] p-[var(--sw-space-4)]",
            "bg-[var(--sw-surface)] text-[var(--sw-text)]",
            "border border-[var(--sw-border)]",
            "rounded-[var(--sw-radius-card)]",
            "text-[length:var(--sw-text-sm)]",
            "outline-none",
            "duration-[var(--sw-duration-enter)] ease-out",
            "data-open:animate-in data-open:fade-in-0",
            "data-closed:animate-out data-closed:fade-out-0",
          ].join(" "),
          className,
        )}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Content>
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-[var(--sw-space-2)]", className)}
      {...props}
    />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn(
        [
          "-mx-[var(--sw-space-4)] -mb-[var(--sw-space-4)] mt-[var(--sw-space-2)]",
          "px-[var(--sw-space-4)] pt-[var(--sw-space-3)] pb-[var(--sw-space-4)]",
          "border-t border-[var(--sw-border)]",
          "flex flex-col-reverse gap-[var(--sw-space-2)] sm:flex-row sm:justify-end",
        ].join(" "),
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-[length:var(--sw-text-md)] font-medium leading-tight text-[var(--sw-text)]", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]", className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
