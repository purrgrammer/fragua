"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { Streamdown } from "streamdown";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { Shimmer } from "./shimmer";

/**
 * Reasoning — collapsible "thinking" disclosure for streaming model output.
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
    // Thinking is never auto-expanded — it stays collapsed by default (even
    // while streaming) and only opens when the operator clicks. An explicit
    // `defaultOpen`/`open` prop still wins for callers that want otherwise.
    const resolvedDefaultOpen = defaultOpen ?? false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const startTimeRef = useRef<number | null>(null);

    // Track streaming start/end only to compute the "Thought for N seconds"
    // duration — no open/close side effects.
    useEffect(() => {
      if (isStreaming) {
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration]);

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
          // No own bottom margin — the parent MessageContent already stacks
          // blocks with a uniform gap; an extra mb here made the trace look
          // bottom-heavy (more space below than above).
          className={cn("not-prose", className)}
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
    // Neutral tone — the state accent belongs to the node's status dot, not
    // the thinking label (§ Color: "labels stay text-sw-muted").
    return (
      <Shimmer duration={1} color="var(--sw-muted)">
        Thinking…
      </Shimmer>
    );
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
      "mt-[var(--sw-space-2)] outline-none",
      // Thinking is secondary context: smaller + muted, set off as a quote
      // (hairline left rule) so it reads as the model's aside, not body copy.
      "text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]",
      "border-l-2 border-[var(--sw-border)] pl-[var(--sw-space-3)]",
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
