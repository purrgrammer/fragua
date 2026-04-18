import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn("scroll-my-[var(--sw-space-1)] p-[var(--sw-space-1)]", className)}
      {...props}
    />
  );
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        // structure
        "flex w-fit items-center justify-between whitespace-nowrap select-none outline-none",
        "gap-[var(--sw-space-2)]",
        "px-[var(--sw-space-2)] py-[var(--sw-space-1)]",
        // surface — same paper/ink as inputs; both themes designed.
        "bg-[var(--sw-surface)] text-[var(--sw-text)]",
        // hairline border, default radius (2px).
        "border border-[var(--sw-border)] rounded-[var(--sw-radius-default)]",
        // body: sm (12px), monospace inherited.
        "text-[length:var(--sw-text-sm)]",
        // sizes — both heights live on the 4px grid (28px / 32px).
        "data-[size=default]:h-8 data-[size=sm]:h-7",
        // motion: 120ms color/border fade only.
        "transition-[background-color,color,border-color]",
        "duration-[var(--sw-duration-hover)] ease-[ease]",
        // focus: hairline border swap to text token (Motion: focus is
        // instant, no ring).
        "focus-visible:border-[var(--sw-text)]",
        // disabled
        "disabled:cursor-not-allowed disabled:opacity-50",
        // invalid: hairline color shift to error accent — no ring.
        "aria-invalid:border-[var(--sw-accent-error)]",
        // placeholder text dims to muted.
        "data-placeholder:text-[var(--sw-muted)]",
        // value slot layout
        "*:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex",
        "*:data-[slot=select-value]:items-center",
        "*:data-[slot=select-value]:gap-[var(--sw-space-2)]",
        // svg sizing — neutral, no decorative tint.
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        "[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="pointer-events-none size-4 text-[var(--sw-muted)]" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "item-aligned",
  align = "center",
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        data-align-trigger={position === "item-aligned"}
        className={cn(
          // structure
          "relative z-50 min-w-36 overflow-x-hidden overflow-y-auto",
          "max-h-(--radix-select-content-available-height)",
          "origin-(--radix-select-content-transform-origin)",
          // surface + hairline + card radius (4px).
          "bg-[var(--sw-surface)] text-[var(--sw-text)]",
          "border border-[var(--sw-border)] rounded-[var(--sw-radius-card)]",
          // motion: enter/exit is a single fade (opacity only),
          // 200ms ease-out per Motion table. Decorative zoom + multi-
          // axis slide dropped.
          "duration-[var(--sw-duration-enter)] ease-out",
          "data-[align-trigger=true]:animate-none",
          "data-open:animate-in data-open:fade-in-0",
          "data-closed:animate-out data-closed:fade-out-0",
          className,
        )}
        position={position}
        align={align}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          data-position={position}
          className={cn(
            "data-[position=popper]:h-(--radix-select-trigger-height)",
            "data-[position=popper]:w-full",
            "data-[position=popper]:min-w-(--radix-select-trigger-width)",
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn(
        // Group label tier — UPPERCASE + ~0.06em tracking is the one
        // place letter-spacing is permitted (§ Typography).
        "px-[var(--sw-space-2)] py-[var(--sw-space-1)]",
        "text-[length:var(--sw-text-xs)] font-medium uppercase tracking-[0.06em]",
        "text-[var(--sw-muted)]",
        className,
      )}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        // structure
        "relative flex w-full cursor-default items-center select-none outline-hidden",
        "gap-[var(--sw-space-2)]",
        "px-[var(--sw-space-2)] py-[var(--sw-space-1)] pr-[var(--sw-space-6)]",
        // default radius (2px).
        "rounded-[var(--sw-radius-default)]",
        // body
        "text-[length:var(--sw-text-sm)]",
        // selection highlight — --sw-bg gives one-notch contrast against
        // the surrounding --sw-surface popover (matches command.tsx).
        "focus:bg-[var(--sw-bg)] focus:text-[var(--sw-text)]",
        // disabled
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        // motion: 120ms color fade on focus/hover (§ Motion).
        "transition-[background-color,color]",
        "duration-[var(--sw-duration-hover)] ease-[ease]",
        // svg sizing
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        "[&_svg:not([class*='size-'])]:size-4",
        // last span (value group) layout
        "*:[span]:last:flex *:[span]:last:items-center",
        "*:[span]:last:gap-[var(--sw-space-2)]",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute right-[var(--sw-space-2)] flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="pointer-events-none" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
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

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center",
        "py-[var(--sw-space-1)]",
        "bg-[var(--sw-surface)] text-[var(--sw-muted)]",
        "[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn(
        "z-10 flex cursor-default items-center justify-center",
        "py-[var(--sw-space-1)]",
        "bg-[var(--sw-surface)] text-[var(--sw-muted)]",
        "[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
