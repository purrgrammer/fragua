"use client";

// Snippet — lightweight inline display for short code references and
// terminal commands. Adapted from the ai-elements Snippet component
// to the Swarm design language: hairline border via InputGroup, mono
// voice, sw-* tokens.
//
// Usage shape:
//
//   <Snippet code="gh pr list" prefix="$" />              // single-line, auto-copy button
//   <Snippet code="long…">                                // composable form
//     <SnippetAddon>$</SnippetAddon>
//     <SnippetInput />
//     <SnippetCopyButton />
//   </Snippet>

import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";

// We thread `code` to descendant `SnippetCopyButton` / `SnippetInput`
// through context so the high-level shape can omit the children. A
// module-scoped context is fine — Snippet is always self-contained,
// never shared across siblings.
const SnippetContext = createContext<{ code: string } | null>(null);

interface SnippetProps extends Omit<ComponentProps<typeof InputGroup>, "children"> {
  /** The code content to display. */
  code: string;
  /** Optional prefix (e.g. "$" for terminal commands). When set, an
   * automatic SnippetAddon + SnippetInput + SnippetCopyButton are
   * rendered. Pass `children` to opt out of the auto-shape. */
  prefix?: string;
  /** Composable subcomponents. When omitted, a default SnippetAddon
   * (with `prefix`), SnippetInput, and SnippetCopyButton are rendered. */
  children?: ReactNode;
}

export function Snippet({ code, prefix, children, className, ...props }: SnippetProps): JSX.Element {
  return (
    <SnippetContext.Provider value={{ code }}>
      <InputGroup data-slot="snippet" className={cn("h-auto items-stretch font-mono text-sw-xs", className)} {...props}>
        {children ?? (
          <>
            {prefix !== undefined ? (
              <SnippetAddon>
                <SnippetText>{prefix}</SnippetText>
              </SnippetAddon>
            ) : null}
            <SnippetInput />
            <SnippetCopyButton />
          </>
        )}
      </InputGroup>
    </SnippetContext.Provider>
  );
}

export function SnippetAddon({ className, ...props }: ComponentProps<typeof InputGroupAddon>): JSX.Element {
  return <InputGroupAddon className={cn("text-sw-muted", className)} {...props} />;
}

export function SnippetText({ className, ...props }: ComponentProps<typeof InputGroupText>): JSX.Element {
  return <InputGroupText className={cn("font-mono text-sw-muted", className)} {...props} />;
}

export function SnippetInput({
  className,
  ...props
}: Omit<ComponentProps<typeof InputGroupInput>, "value" | "readOnly">): JSX.Element {
  const ctx = useSnippetContext();
  return (
    <InputGroupInput
      data-slot="snippet-input"
      readOnly
      value={ctx.code}
      className={cn(
        // Snippet body: mono, transparent, no border (the InputGroup hairline owns the chrome).
        "font-mono text-sw-xs text-sw-text",
        "bg-transparent",
        // Selectable but not editable; remove the focus underline since
        // the InputGroup already manages the focus ring.
        "cursor-text selection:bg-sw-accent-thinking/30",
        className,
      )}
      {...props}
    />
  );
}

interface SnippetCopyButtonProps
  extends Omit<ComponentProps<typeof InputGroupButton>, "onClick" | "children" | "onError"> {
  onCopy?: () => void;
  onError?: (err: Error) => void;
  timeout?: number;
  children?: ReactNode;
}

export function SnippetCopyButton({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: SnippetCopyButtonProps): JSX.Element {
  const ctx = useSnippetContext();
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(ctx.code);
      setCopied(true);
      onCopy?.();
      window.setTimeout(() => setCopied(false), timeout);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  return (
    <InputGroupButton
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? "Copied" : "Copy"}
      onClick={() => {
        void handleCopy();
      }}
      className={cn("text-sw-muted hover:text-sw-text", className)}
      {...props}
    >
      {children ?? (copied ? <CheckIcon className="size-3 text-sw-accent-success" /> : <CopyIcon className="size-3" />)}
    </InputGroupButton>
  );
}

function useSnippetContext(): { code: string } {
  const ctx = useContext(SnippetContext);
  if (ctx == null) throw new Error("Snippet subcomponents must be wrapped in <Snippet>");
  return ctx;
}
