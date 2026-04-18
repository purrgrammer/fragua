"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { Shimmer } from "./shimmer";

/**
 * Reasoning — collapsible "thinking" disclosure for streaming model output.
 *
 * Styling notes (see .agents/skills/design/SKILL.md):
 *   - Token-only colour, spacing, motion. No shadcn aliases
 *     (`text-muted-foreground`, `text-sm`, `hover:text-foreground`),
 *     no raw tailwind spacing (`gap-2`, `mt-4`, `mb-4`, `size-4`).
 *     § Authoring checklist; § Spacing ("These steps only").
 *   - Body prose uses `--sw-text` (the legibility token), not `--sw-muted`
 *     (which is reserved for labels / secondary metadata). § Color tokens.
 *   - Trigger label is muted; hover lifts to `--sw-text`. Hover motion is
 *     colour-only, 120ms ease. § Motion: "Hover, color shift … 120ms ease".
 *   - Chevron rotation and content open/close share `--sw-duration-enter`
 *     ease-out — paired easing per § Motion: "paired elements … share
 *     easing and duration". (Chevron uses status duration to settle a hair
 *     before content finishes — both are status-class transforms.)
 *   - "Thinking" state is carried by `<Shimmer>` (opacity pulse on
 *     `--sw-accent-thinking`, 1800ms floor). § Motion: "Pulse is slow.
 *     1800ms floor"; § Color: accent.thinking is the alive colour.
 *   - Slide distance reduced from 8px → 4px (`slide-…-top-1`) to keep the
 *     transform within the spacing scale. § Spacing.
 */

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    // Track if defaultOpen was explicitly set to false (to prevent auto-open)
    const isExplicitlyClosed = defaultOpen === false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const startTimeRef = useRef<number | null>(null);

    // Track when streaming starts and compute duration
    useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true;
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration]);

    // Auto-open when streaming starts (unless explicitly closed)
    useEffect(() => {
      if (isStreaming && !isOpen && !isExplicitlyClosed) {
        setIsOpen(true);
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

    // Auto-close when streaming ends (once only, and only if it ever streamed)
    useEffect(() => {
      if (hasEverStreamedRef.current && !isStreaming && isOpen && !hasAutoClosed) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen);
      },
      [setIsOpen],
    );

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen],
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose mb-[var(--sw-space-4)]", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    // Sentence case, not Title Case (§ Typography: "Never Title Case").
    return <Shimmer duration={1}>Thinking…</Shimmer>;
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>;
  }
  return <p>Thought for {duration} seconds</p>;
};

export const ReasoningTrigger = memo(
  ({ className, children, getThinkingMessage = defaultGetThinkingMessage, ...props }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center",
          "gap-[var(--sw-space-2)]",
          "text-[length:var(--sw-text-sm)] text-[var(--sw-muted)]",
          // Hover: colour shift only, 120ms ease (§ Motion).
          "transition-colors duration-[var(--sw-duration-hover)] ease",
          "hover:text-[var(--sw-text)]",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-[var(--sw-text-md)]" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn(
                "size-[var(--sw-text-md)]",
                // Status-flip transform, paired with content open/close
                // (§ Motion: status transition 160ms ease).
                "transition-transform duration-[var(--sw-duration-status)] ease",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
  children: string;
};

const streamdownPlugins = { cjk, code, math, mermaid };

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => (
  <CollapsibleContent
    className={cn(
      // Enter/exit on transform + opacity only, paired with the chevron.
      // § Motion: "Only animate transform and opacity"; "Drawer / panel
      // enter-exit … 200ms ease-out".
      "mt-[var(--sw-space-3)] outline-none",
      "text-[length:var(--sw-text-sm)] text-[var(--sw-text)]",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
      "data-[state=open]:slide-in-from-top-1 data-[state=closed]:slide-out-to-top-1",
      "duration-[var(--sw-duration-enter)] ease-out",
      className,
    )}
    {...props}
  >
    <Streamdown plugins={streamdownPlugins}>{children}</Streamdown>
  </CollapsibleContent>
));

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
