import { Command as CommandPrimitive } from "cmdk";
import { CheckIcon, SearchIcon } from "lucide-react";
import type * as React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

/*
 * Command — Swarm design language.
 *
 * Skill citations (.agents/skills/design/SKILL.md):
 *   § Color               — only --sw-* tokens; shadcn aliases
 *                           (bg-popover, bg-muted, text-foreground,
 *                           border-input, bg-border…) removed. Selection
 *                           uses --sw-surface (one-notch separation),
 *                           never opacity-faded "input" colours.
 *   § Borders & elevation — "Radius: 2px default, 4px cards/drawers."
 *                           Container/dialog → --sw-radius-card; items →
 *                           --sw-radius-default. No box-shadow; the
 *                           leftover `shadow-none!` override is dropped.
 *   § Layout              — sections separated by a hairline (separator
 *                           uses --sw-border, not bg-border).
 *   § Typography          — monospace inherited; sizes from --sw-text-*
 *                           scale; group headings use UPPERCASE +
 *                           ~0.06em tracking (the only place letter-
 *                           spacing is permitted). Shortcut text drops
 *                           `tracking-widest` (decorative).
 *   § Spacing             — token scale only. Off-scale `p-1`, `pb-0`,
 *                           `py-1.5`, `py-6`, `px-2 py-1.5` replaced with
 *                           --sw-space-* (4/8/12/24).
 *   § Motion              — only colour transitions on item hover/select,
 *                           120ms ease via --sw-duration-hover. No
 *                           transform/opacity decoration on mount.
 *
 * Behavioural API (Command, CommandDialog + title/description/className/
 * showCloseButton, CommandInput, CommandList, CommandEmpty, CommandGroup,
 * CommandItem, CommandShortcut, CommandSeparator) preserved unchanged.
 */

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        // structure: full bleed inside its parent (dialog or popover).
        "flex size-full flex-col overflow-hidden",
        // surface + radius — drawer-tier card radius (4px).
        "bg-[var(--sw-surface)] text-[var(--sw-text)]",
        "rounded-[var(--sw-radius-card)]",
        // padding token — 4px gutter inside the palette.
        "p-[var(--sw-space-1)]",
        className,
      )}
      {...props}
    />
  );
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  showCloseButton?: boolean;
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          // top-1/3 placement preserved (palette convention); zero padding
          // so the inner Command owns its gutter. Card radius (4px) is the
          // skill default for drawers — no rounded-xl override.
          "top-1/3 translate-y-0 overflow-hidden p-0",
          "rounded-[var(--sw-radius-card)]",
          className,
        )}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="p-[var(--sw-space-1)] pb-0">
      <InputGroup
        className={cn(
          // 32px row, default radius (2px). `border-input/30 bg-input/30
          // shadow-none!` removed: opacity-faded shadcn aliases are an
          // §Color anti-pattern in dark mode (auto-invert), and shadow
          // is already none everywhere.
          "h-8 *:data-[slot=input-group-addon]:pl-[var(--sw-space-2)]",
        )}
      >
        <CommandPrimitive.Input
          data-slot="command-input"
          className={cn(
            // sm body (12px), token-sized. outline-hidden retained so the
            // group's focus ring is the visible affordance.
            "w-full text-[length:var(--sw-text-sm)] outline-hidden",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          {...props}
        />
        <InputGroupAddon>
          <SearchIcon className="size-4 shrink-0 text-[var(--sw-muted)]" />
        </InputGroupAddon>
      </InputGroup>
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "no-scrollbar max-h-72 overflow-x-hidden overflow-y-auto outline-none",
        // scroll padding snaps highlighted item to a 4px row gap.
        "scroll-py-[var(--sw-space-1)]",
        className,
      )}
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn(
        // sm body, muted — secondary information.
        "py-[var(--sw-space-6)] text-center",
        "text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]",
        className,
      )}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden p-[var(--sw-space-1)] text-[var(--sw-text)]",
        // Group heading: UPPERCASE label tier — the one place ~0.06em
        // tracking is permitted (§ Typography "UPPERCASE with ~0.06em
        // letter-spacing for section labels"). xs size, weight 500,
        // muted colour.
        "**:[[cmdk-group-heading]]:px-[var(--sw-space-2)]",
        "**:[[cmdk-group-heading]]:py-[var(--sw-space-1)]",
        "**:[[cmdk-group-heading]]:text-[length:var(--sw-text-xs)]",
        "**:[[cmdk-group-heading]]:font-medium",
        "**:[[cmdk-group-heading]]:uppercase",
        "**:[[cmdk-group-heading]]:tracking-[0.06em]",
        "**:[[cmdk-group-heading]]:text-[var(--sw-muted)]",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn(
        // Section break is a 1px hairline, not a tinted band
        // (§ Layout: "sections separated by a hairline").
        "-mx-[var(--sw-space-1)] h-px bg-[var(--sw-border)]",
        className,
      )}
      {...props}
    />
  );
}

function CommandItem({ className, children, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        // structure
        "group/command-item relative flex cursor-default select-none items-center",
        "gap-[var(--sw-space-2)]",
        "px-[var(--sw-space-2)] py-[var(--sw-space-1)]",
        // default radius (2px) everywhere — drops the rounded-lg! override
        // when nested in a dialog (skill: 2px default for items).
        "rounded-[var(--sw-radius-default)]",
        // body
        "text-[length:var(--sw-text-sm)] outline-hidden",
        // disabled
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        // selection: use --sw-bg as the highlight (one-notch contrast
        // against the surface palette around it). No "muted" misuse.
        "data-selected:bg-[var(--sw-bg)] data-selected:text-[var(--sw-text)]",
        // motion: 120ms colour fade on hover/selection (§ Motion:
        // "Hover, color shift — 120ms ease").
        "transition-[background-color,color]",
        "duration-[var(--sw-duration-hover)] ease-[ease]",
        // svg sizing — neutral, no decorative tinting.
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        "[&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <CheckIcon className="ml-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100" />
    </CommandPrimitive.Item>
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        // Shortcut hint: xs size, muted, mono inherited. No
        // `tracking-widest` — decorative letter-spacing is reserved for
        // UPPERCASE labels (§ Typography).
        "ml-auto text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]",
        "group-data-selected/command-item:text-[var(--sw-text)]",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
