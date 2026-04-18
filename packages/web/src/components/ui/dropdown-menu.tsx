import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          // structure
          "z-50 min-w-36 overflow-x-hidden overflow-y-auto",
          "max-h-(--radix-dropdown-menu-content-available-height)",
          "w-(--radix-dropdown-menu-trigger-width)",
          "origin-(--radix-dropdown-menu-content-transform-origin)",
          "p-[var(--sw-space-1)]",
          // surface + hairline + card radius (4px).
          "bg-[var(--sw-surface)] text-[var(--sw-text)]",
          "border border-[var(--sw-border)] rounded-[var(--sw-radius-card)]",
          // motion: enter/exit is a single opacity fade,
          // 200ms ease-out per Motion table. Decorative zoom + multi-
          // axis slide dropped.
          "duration-[var(--sw-duration-enter)] ease-out",
          "data-[state=closed]:overflow-hidden",
          "data-open:animate-in data-open:fade-in-0",
          "data-closed:animate-out data-closed:fade-out-0",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

// Shared item className — used by Item, CheckboxItem, RadioItem,
// SubTrigger so focus, motion, sizing, and inset behaviour stay in
// lockstep.
const itemBase = cn(
  // structure
  "relative flex cursor-default items-center select-none outline-hidden",
  "gap-[var(--sw-space-2)]",
  "px-[var(--sw-space-2)] py-[var(--sw-space-1)]",
  // default radius (2px).
  "rounded-[var(--sw-radius-default)]",
  // body
  "text-[length:var(--sw-text-sm)]",
  // inset variant — reserves leading icon column on the 4px grid.
  "data-inset:pl-[var(--sw-space-6)]",
  // motion: 120ms color fade on hover/focus (§ Motion).
  "transition-[background-color,color]",
  "duration-[var(--sw-duration-hover)] ease-[ease]",
  // disabled
  "data-disabled:pointer-events-none data-disabled:opacity-50",
  // svg sizing — neutral, no decorative tint.
  "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  "[&_svg:not([class*='size-'])]:size-4",
);

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "group/dropdown-menu-item",
        itemBase,
        // selection highlight — --sw-bg gives one-notch contrast against
        // the surrounding --sw-surface popover (matches select.tsx).
        "focus:bg-[var(--sw-bg)] focus:text-[var(--sw-text)]",
        // destructive variant — error accent is the only colour used as
        // a non-state signal here, and it *is* a state (§ Color).
        "data-[variant=destructive]:text-[var(--sw-accent-error)]",
        "data-[variant=destructive]:*:[svg]:text-[var(--sw-accent-error)]",
        "data-[variant=destructive]:focus:text-[var(--sw-accent-error)]",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        itemBase,
        // reserve trailing column for indicator.
        "pr-[var(--sw-space-6)]",
        "focus:bg-[var(--sw-bg)] focus:text-[var(--sw-text)]",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-[var(--sw-space-2)] flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        itemBase,
        "pr-[var(--sw-space-6)]",
        "focus:bg-[var(--sw-bg)] focus:text-[var(--sw-text)]",
        className,
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-[var(--sw-space-2)] flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        // Group label tier — UPPERCASE + 0.06em tracking is the one
        // place letter-spacing is permitted (§ Typography).
        "px-[var(--sw-space-2)] py-[var(--sw-space-1)]",
        "text-[length:var(--sw-text-xs)] font-medium uppercase tracking-[0.06em]",
        "text-[var(--sw-muted)]",
        "data-inset:pl-[var(--sw-space-6)]",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(
        // Hairline section break (§ Layout: "sections separated by a
        // hairline").
        "pointer-events-none h-px bg-[var(--sw-border)]",
        "-mx-[var(--sw-space-1)] my-[var(--sw-space-1)]",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        // Shortcut is data, not a label — muted monospace, tabular
        // figures inherited globally. tracking-widest dropped (tracking
        // is reserved for UPPERCASE labels per § Typography).
        "ml-auto text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        itemBase,
        "focus:bg-[var(--sw-bg)] focus:text-[var(--sw-text)]",
        "data-open:bg-[var(--sw-bg)] data-open:text-[var(--sw-text)]",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(
        // structure
        "z-50 min-w-36 overflow-hidden",
        "origin-(--radix-dropdown-menu-content-transform-origin)",
        "p-[var(--sw-space-1)]",
        // surface + hairline + card radius (4px).
        "bg-[var(--sw-surface)] text-[var(--sw-text)]",
        "border border-[var(--sw-border)] rounded-[var(--sw-radius-card)]",
        // motion: same single fade as Content (§ Motion).
        "duration-[var(--sw-duration-enter)] ease-out",
        "data-open:animate-in data-open:fade-in-0",
        "data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
