"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/*
 * InputGroup — Swarm design language.
 *
 * Skill citations (.swarm/skills/design/SKILL.md):
 *   § Borders & elevation — "1px only" / "Radius: 2px default";
 *                           focus ring is 1px and instant (matches Input).
 *                           No shadow, no ring-3.
 *   § Typography           — monospace (inherited); body = --sw-text-sm
 *                            (12px); secondary text uses --sw-muted, not
 *                            font-medium ornament.
 *   § Spacing              — 4px base; only --sw-space-* steps. No 1.5/2.5
 *                            half-steps, no arbitrary negative margins.
 *   § Color                — accents = state; --sw-* tokens only. No
 *                            shadcn aliases (border-input, ring-ring, etc).
 *                            Dark is a peer via tokens, not auto-inverted
 *                            opacity overrides.
 *   § Motion               — colour-class transitions only, 120ms ease.
 *
 * Behavioural API is preserved — every prop spreads through unchanged;
 * data-slot attributes and align variants are kept intact.
 */

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn(
        // structure
        "group/input-group relative flex h-8 w-full min-w-0 items-center",
        "rounded-[var(--sw-radius-default)]",
        "border border-[var(--sw-border)] bg-transparent",

        // motion: colour-only, 120ms ease (matches Input).
        "transition-[background-color,border-color,color]",
        "duration-[var(--sw-duration-hover)] ease-[ease] outline-none",

        // disabled — single token surface, no opacity ladder.
        "has-disabled:bg-[var(--sw-surface)] has-disabled:opacity-50",

        // focus — 1px ring, matches Input.
        "has-[[data-slot=input-group-control]:focus-visible]:border-[var(--sw-text)]",
        "has-[[data-slot=input-group-control]:focus-visible]:ring-1",
        "has-[[data-slot=input-group-control]:focus-visible]:ring-[var(--sw-text)]",

        // aria-invalid — accent.error state, 1px only.
        "has-[[data-slot][aria-invalid=true]]:border-[var(--sw-accent-error)]",
        "has-[[data-slot][aria-invalid=true]]:ring-1",
        "has-[[data-slot][aria-invalid=true]]:ring-[var(--sw-accent-error)]",

        // combobox-content opt-out (preserved behaviour).
        "in-data-[slot=combobox-content]:focus-within:border-inherit",
        "in-data-[slot=combobox-content]:focus-within:ring-0",

        // block-aligned addon → vertical stack.
        "has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-end]]:flex-col",
        "has-[>[data-align=block-start]]:h-auto has-[>[data-align=block-start]]:flex-col",
        "has-[>textarea]:h-auto",

        // input padding adjustments — snap to --sw-space-* tokens.
        "has-[>[data-align=block-end]]:[&>input]:pt-[var(--sw-space-3)]",
        "has-[>[data-align=block-start]]:[&>input]:pb-[var(--sw-space-3)]",
        "has-[>[data-align=inline-end]]:[&>input]:pr-[var(--sw-space-1)]",
        "has-[>[data-align=inline-start]]:[&>input]:pl-[var(--sw-space-1)]",

        className,
      )}
      {...props}
    />
  );
}

const inputGroupAddonVariants = cva(
  cn(
    // structure
    "flex h-auto cursor-text items-center justify-center select-none",
    "gap-[var(--sw-space-2)] py-[var(--sw-space-1)]",

    // typography: default body size; muted colour, no font-weight ornament.
    "text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]",

    // disabled within group
    "group-data-[disabled=true]/input-group:opacity-50",

    // child sizing
    "[&>kbd]:rounded-[var(--sw-radius-default)]",
    "[&>svg:not([class*='size-'])]:size-4",
  ),
  {
    variants: {
      align: {
        "inline-start": "order-first pl-[var(--sw-space-2)]",
        "inline-end": "order-last pr-[var(--sw-space-2)]",
        "block-start":
          "order-first w-full justify-start px-[var(--sw-space-3)] pt-[var(--sw-space-2)] group-has-[>input]/input-group:pt-[var(--sw-space-2)] [.border-b]:pb-[var(--sw-space-2)]",
        "block-end":
          "order-last w-full justify-start px-[var(--sw-space-3)] pb-[var(--sw-space-2)] group-has-[>input]/input-group:pb-[var(--sw-space-2)] [.border-t]:pt-[var(--sw-space-2)]",
      },
    },
    defaultVariants: {
      align: "inline-start",
    },
  },
);

function InputGroupAddon({
  className,
  align = "inline-start",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
  return (
    <div
      role="group"
      data-slot="input-group-addon"
      data-align={align}
      className={cn(inputGroupAddonVariants({ align }), className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) {
          return;
        }
        e.currentTarget.parentElement?.querySelector("input")?.focus();
      }}
      {...props}
    />
  );
}

const inputGroupButtonVariants = cva(
  cn(
    // structure: no shadow, monospace (inherited), default body size.
    "flex items-center gap-[var(--sw-space-2)]",
    "text-[length:var(--sw-text-sm)]",
  ),
  {
    variants: {
      size: {
        xs: "h-6 gap-[var(--sw-space-1)] rounded-[var(--sw-radius-default)] px-[var(--sw-space-2)] [&>svg:not([class*='size-'])]:size-3.5",
        sm: "",
        "icon-xs": "size-6 rounded-[var(--sw-radius-default)] p-0 has-[>svg]:p-0",
        "icon-sm": "size-8 p-0 has-[>svg]:p-0",
      },
    },
    defaultVariants: {
      size: "xs",
    },
  },
);

function InputGroupButton({
  className,
  type = "button",
  variant = "ghost",
  size = "xs",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size"> & VariantProps<typeof inputGroupButtonVariants>) {
  return (
    <Button
      type={type}
      data-size={size}
      variant={variant}
      className={cn(inputGroupButtonVariants({ size }), className)}
      {...props}
    />
  );
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "flex items-center gap-[var(--sw-space-2)]",
        "text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]",
        "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <Input
      data-slot="input-group-control"
      className={cn(
        // strip the wrapper-owned chrome from the inner Input.
        "flex-1 rounded-none border-0 bg-transparent ring-0",
        "focus-visible:ring-0 focus-visible:border-0",
        "disabled:bg-transparent",
        "aria-invalid:ring-0 aria-invalid:border-0",
        className,
      )}
      {...props}
    />
  );
}

function InputGroupTextarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <Textarea
      data-slot="input-group-control"
      className={cn(
        "flex-1 resize-none rounded-none border-0 bg-transparent ring-0",
        "py-[var(--sw-space-2)]",
        "focus-visible:ring-0 focus-visible:border-0",
        "disabled:bg-transparent",
        "aria-invalid:ring-0 aria-invalid:border-0",
        className,
      )}
      {...props}
    />
  );
}

export { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupInput, InputGroupTextarea };
