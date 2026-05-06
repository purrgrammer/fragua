"use client";

// Terminal — ANSI-aware console-output renderer for tool nodes
// (parallelogram shape) and any other captured shell output.
//
// Adapted from the ai-elements Terminal component to match the Swarm
// design language: hairline border, no shadow, monospace voice, sw-*
// tokens for surfaces/borders/spacing. In dark mode the body keeps a
// darker terminal-idiom surface so ANSI colors from `ansi-to-react`
// read as designed; in light mode it sits on the standard sw-surface
// so the component adapts to the theme instead of punching a dark
// block into a light page.

import Ansi from "ansi-to-react";
import { CheckIcon, CopyIcon, EraserIcon, TerminalIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { forwardRef, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface TerminalProps {
  /** Raw output text (ANSI escape codes are parsed). */
  output: string;
  /** Show a blinking cursor + "streaming" indicator at the tail. */
  isStreaming?: boolean;
  /** Auto-scroll to the latest line on output change. Defaults to true. */
  autoScroll?: boolean;
  /** When provided, a clear button is rendered in the header. */
  onClear?: () => void;
  /** Optional title shown in the header (e.g., the command). Falls
   * back to "Terminal". */
  title?: string;
  /** Optional status string shown right of the title (e.g., "exit 0",
   * "running"). Tone follows the prop value: "exit 0" reads as success,
   * non-zero as error, "running" as thinking. Use `tone` to override. */
  status?: string;
  tone?: "success" | "error" | "thinking" | "muted";
  className?: string;
}

export function Terminal({
  output,
  isStreaming = false,
  autoScroll = true,
  onClear,
  title,
  status,
  tone,
  className,
}: TerminalProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom whenever output grows, but only if the user is
  // already at (or near) the bottom — don't yank them mid-scroll if
  // they paged up to inspect earlier output. `output` is the trigger:
  // it isn't read inside the effect (we read the DOM's scrollHeight,
  // which the post-render layout has already updated), but the prop
  // change is what schedules this effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: output drives the re-render that brings new layout into the DOM
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 64) {
      el.scrollTop = el.scrollHeight;
    }
  }, [output, autoScroll]);

  const inferredTone: TerminalProps["tone"] =
    tone ?? (status === "running" ? "thinking" : status?.startsWith("exit 0") ? "success" : status ? "error" : "muted");

  return (
    <div
      data-testid="terminal"
      className={cn(
        "flex flex-col overflow-hidden rounded-sw-card border border-sw-border",
        "bg-sw-surface",
        className,
      )}
    >
      <TerminalHeader>
        <TerminalTitle>
          <TerminalIcon className="size-3.5 text-sw-muted" aria-hidden />
          {title ? (
            <span className="truncate" title={title}>
              {title}
            </span>
          ) : null}
        </TerminalTitle>
        {status ? (
          <TerminalStatus tone={inferredTone} pulse={isStreaming || status === "running"}>
            {status}
          </TerminalStatus>
        ) : null}
        <TerminalActions>
          <TerminalCopyButton text={output} />
          {onClear ? <TerminalClearButton onClick={onClear} /> : null}
        </TerminalActions>
      </TerminalHeader>
      <TerminalContent ref={scrollRef}>
        <Ansi>{output}</Ansi>
        {isStreaming ? (
          <span aria-hidden className="ml-0.5 inline-block size-2 translate-y-[1px] bg-sw-accent-thinking sw-pulse" />
        ) : null}
      </TerminalContent>
    </div>
  );
}

// ─── Composable parts ──────────────────────────────────────────────

export function TerminalHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-sw-border px-3 py-1.5",
        "text-sw-xs uppercase tracking-[0.06em] text-sw-muted",
        className,
      )}
      {...props}
    />
  );
}

export function TerminalTitle({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-sw-text", className)} {...props} />;
}

export function TerminalStatus({
  className,
  tone = "muted",
  pulse,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: TerminalProps["tone"]; pulse?: boolean }): JSX.Element {
  const textTone =
    tone === "success"
      ? "text-sw-accent-success"
      : tone === "error"
        ? "text-sw-accent-error"
        : tone === "thinking"
          ? "text-sw-accent-thinking"
          : "text-sw-muted";
  const dotTone =
    tone === "success"
      ? "bg-sw-accent-success"
      : tone === "error"
        ? "bg-sw-accent-error"
        : tone === "thinking"
          ? "bg-sw-accent-thinking"
          : "bg-sw-muted";
  return (
    <div className={cn("flex items-center gap-1.5", className)} {...props}>
      {pulse ? <span aria-hidden className={cn("size-1.5 rounded-full sw-pulse", dotTone)} /> : null}
      <span className={cn("font-medium", textTone)}>{props.children}</span>
    </div>
  );
}

export function TerminalActions({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn("flex items-center gap-1", className)} {...props} />;
}

interface TerminalCopyButtonProps extends Omit<ComponentProps<typeof Button>, "onClick" | "onError"> {
  text: string;
  onCopy?: () => void;
  onError?: (err: Error) => void;
  timeout?: number;
}

export function TerminalCopyButton({
  text,
  onCopy,
  onError,
  timeout = 2000,
  className,
  ...props
}: TerminalCopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      onCopy?.();
      window.setTimeout(() => setCopied(false), timeout);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={copied ? "Copied" : "Copy output"}
      onClick={() => {
        void handleCopy();
      }}
      className={cn("size-6 text-sw-muted hover:text-sw-text", className)}
      {...props}
    >
      {copied ? <CheckIcon className="size-3.5 text-sw-accent-success" /> : <CopyIcon className="size-3.5" />}
    </Button>
  );
}

export function TerminalClearButton({ className, ...props }: ComponentProps<typeof Button>): JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Clear output"
      className={cn("size-6 text-sw-muted hover:text-sw-text", className)}
      {...props}
    >
      <EraserIcon className="size-3.5" />
    </Button>
  );
}

export const TerminalContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function TerminalContent(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        "max-h-96 overflow-auto px-3 py-2",
        "bg-sw-surface text-sw-text dark:bg-zinc-950 dark:text-zinc-100",
        "font-mono text-sw-xs leading-relaxed",
        // ansi-to-react emits inline spans with ANSI colors; preserve
        // whitespace so ASCII tables and indentation render verbatim.
        "whitespace-pre-wrap break-all",
        className,
      )}
      {...props}
    />
  );
});
