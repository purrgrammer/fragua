"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  BookOpenIcon,
  BotIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  type LucideIcon,
  OctagonXIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

import { CodeBlock } from "./code-block";

/*
 * Swarm design language — tool / tool-call card
 *
 *   § Color           — state colours mapped to `--sw-accent-*` tokens
 *                       (success / error / warn / thinking / idle). The
 *                       previous Tailwind palette literals (`text-yellow-600`,
 *                       `text-green-600`, …) were brand colours, not state
 *                       tokens, and broke "no hex literals — theme tokens
 *                       only".
 *   § Borders         — outer card uses `--sw-radius-card` (4px); the input /
 *                       output panels switch from `bg-muted/50` background-
 *                       shade hierarchy to a hairline on `--sw-surface`
 *                       ("sections separated by a hairline — never by a
 *                       different background shade").
 *   § Typography      — sizes via `--sw-text-*`; section labels keep their
 *                       UPPERCASE form with `0.06em` letter-spacing per the
 *                       skill. Built-in tool labels are now Sentence case
 *                       ("Read file", not "Read File") — the skill is
 *                       explicit: "Never Title Case."
 *   § Spacing         — paddings, gaps and stack rhythm snap to
 *                       `--sw-space-*` tokens.
 *   § Motion          — the running indicator uses the global `.sw-pulse`
 *                       (1800ms ease-in-out, prefers-reduced-motion-aware)
 *                       instead of Tailwind's `animate-pulse` (linear, no
 *                       reduced-motion fallback).
 */

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      "group not-prose w-full",
      "mb-[var(--sw-space-4)]",
      "rounded-[var(--sw-radius-card)] border border-[var(--sw-border)]",
      "bg-[var(--sw-surface)]",
      className,
    )}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
  /** Override the default icon resolution. Used by extension-paired
   *  `*.web.tsx` renderers that ship their own Lucide icon. When unset,
   *  falls back to `TOOL_PRESENTATION[name]` then `WrenchIcon`. */
  iconOverride?: LucideIcon;
  /** Override the rendered label. Used by callers that want a richer
   *  per-call name (e.g. an `agent` toolCall surfaces as
   *  `Agent · <description>`); if unset, falls back to
   *  `TOOL_PRESENTATION[name].label` then a humanised slug. */
  labelOverride?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  // Sentence case only (skill: "Never Title Case anywhere.").
  "approval-requested": "Awaiting approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

// Icons carry state colour via `--sw-accent-*` tokens — no Tailwind palette
// literals. The "running" icon pulses via the global `.sw-pulse` utility,
// which honours `prefers-reduced-motion` and uses ease-in-out at 1800ms.
const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 sw-pulse" style={{ color: "var(--sw-accent-thinking)" }} />,
  "approval-responded": <CheckCircleIcon className="size-4" style={{ color: "var(--sw-accent-success)" }} />,
  "input-available": <ClockIcon className="size-4 sw-pulse" style={{ color: "var(--sw-accent-thinking)" }} />,
  "input-streaming": <CircleIcon className="size-4" style={{ color: "var(--sw-accent-idle)" }} />,
  "output-available": <CheckCircleIcon className="size-4" style={{ color: "var(--sw-accent-success)" }} />,
  "output-denied": <XCircleIcon className="size-4" style={{ color: "var(--sw-accent-warn)" }} />,
  "output-error": <XCircleIcon className="size-4" style={{ color: "var(--sw-accent-error)" }} />,
};

// Map state → Badge variant. Badge variants resolve to the same `--sw-accent-*`
// tokens, so the dot/icon colour and the chip stay in sync without inversion.
const statusVariants: Record<ToolPart["state"], "secondary" | "success" | "destructive" | "warning"> = {
  "approval-requested": "warning",
  "approval-responded": "success",
  "input-available": "secondary",
  "input-streaming": "secondary",
  "output-available": "success",
  "output-denied": "warning",
  "output-error": "destructive",
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-[var(--sw-space-1)]" variant={statusVariants[status]}>
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

/** Built-in swarm tool registry — header icon + human-readable label,
 * keyed by canonical `domain:name` (see `packages/workspace/src/tools.ts`).
 * Unknown tools fall back to a generic wrench and a sentence-cased slug. */
interface ToolPresentation {
  icon: LucideIcon;
  label: string;
}

// Sentence case (skill: "Never Title Case anywhere."). Swarm tool
// names are bare identifiers — `read`, `write`, `edit`, `bash`.
export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  bash: { icon: TerminalIcon, label: "Bash" },
  read: { icon: FileTextIcon, label: "Read file" },
  write: { icon: FilePlusIcon, label: "Write file" },
  edit: { icon: PencilIcon, label: "Edit file" },
  grep: { icon: SearchIcon, label: "Grep" },
  find: { icon: FileSearchIcon, label: "Find" },
  ls: { icon: FolderIcon, label: "List directory" },
  web_fetch: { icon: GlobeIcon, label: "Web fetch" },
  // Label intentionally absent — `AssistantMessageRow` passes a
  // per-call `labelOverride` of `Agent · <description>` so each
  // spawn shows its caller-supplied label rather than a generic noun.
  agent: { icon: BotIcon, label: "Agent" },
  skill: { icon: BookOpenIcon, label: "Skill" },
  abort: { icon: OctagonXIcon, label: "Abort" },
};

/** Resolve a tool name to its registry entry. Accepts either the bare
 * tool name (`bash`) or the AI-SDK slug (`tool-bash`) emitted by
 * `toolTypeFromName`. */
function lookupTool(toolName: string | undefined): ToolPresentation | undefined {
  if (!toolName) return undefined;
  const direct = TOOL_PRESENTATION[toolName];
  if (direct) return direct;
  const stripped = toolName.replace(/^tool-/, "");
  return TOOL_PRESENTATION[stripped];
}

/** Sentence-case an unknown tool's name so `do_thing` renders as
 * "Do thing" instead of leaking the raw slug or producing Title Case
 * (which the skill explicitly forbids). */
function humanizeToolName(toolName: string): string {
  const stripped = toolName.replace(/^tool-/, "");
  const namePart = stripped;
  const words = namePart.split(/[_\s]+/).filter(Boolean);
  if (words.length === 0) return namePart;
  const first = words[0] as string;
  const rest = words.slice(1);
  return [first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(), ...rest.map((w) => w.toLowerCase())].join(" ");
}

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  iconOverride,
  labelOverride,
  ...props
}: ToolHeaderProps) => {
  const derivedName = type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  // `title` carries the canonical tool name (e.g. `bash`) when the
  // caller has it; fall back to the derived slug. Look up the registry
  // for icon + human-readable label, and humanize unknown tools.
  const raw = title ?? derivedName;
  const entry = lookupTool(raw);
  const Icon = iconOverride ?? entry?.icon ?? WrenchIcon;
  const label = labelOverride ?? entry?.label ?? humanizeToolName(raw);

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between",
        "gap-[var(--sw-space-4)] p-[var(--sw-space-3)]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-[var(--sw-space-2)]">
        <Icon className="size-4" style={{ color: "var(--sw-muted)" }} />
        <span className="font-medium text-[length:var(--sw-text-sm)]">{label}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon
        className="size-4 transition-transform group-data-[state=open]:rotate-180"
        style={{ color: "var(--sw-muted)" }}
      />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      // Drawer-like enter/exit: slide + fade, paired easing, ≤200ms.
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2",
      "data-[state=open]:slide-in-from-top-2",
      "data-[state=closed]:animate-out data-[state=open]:animate-in",
      "outline-none",
      // Hairline separates the disclosure from the header — no shade hierarchy.
      "border-t border-[var(--sw-border)]",
      "space-y-[var(--sw-space-3)]",
      "px-[var(--sw-space-3)] py-[var(--sw-space-3)]",
      "text-[var(--sw-text)]",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

// Section header style shared by Input/Output: UPPERCASE label with the
// 0.06em letter-spacing the skill calls out for column / section labels.
const SECTION_LABEL = cn(
  "font-medium uppercase",
  "text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]",
  "tracking-[0.06em]",
);

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-[var(--sw-space-2)] overflow-hidden", className)} {...props}>
    <h4 className={SECTION_LABEL}>Parameters</h4>
    {/* CodeBlock already renders its own hairline + surface — wrapping it in
        another tinted background would create the shade-hierarchy anti-pattern. */}
    <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />;
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  // Error state: tint the container with a low-chroma mix of the error
  // accent (theme-aware, no opacity hack on a brand colour). Text uses the
  // accent token directly so both themes stay legible without inversion.
  return (
    <div className={cn("space-y-[var(--sw-space-2)]", className)} {...props}>
      {errorText && <h4 className={SECTION_LABEL}>Error</h4>}
      <div
        className={cn(
          "overflow-x-auto",
          "rounded-[var(--sw-radius-default)] border",
          "text-[length:var(--sw-text-xs)] [&_table]:w-full",
        )}
        style={
          errorText
            ? {
                borderColor: "color-mix(in oklch, var(--sw-accent-error) 30%, transparent)",
                backgroundColor: "color-mix(in oklch, var(--sw-accent-error) 8%, transparent)",
                color: "var(--sw-accent-error)",
              }
            : {
                borderColor: "var(--sw-border)",
                backgroundColor: "var(--sw-surface)",
                color: "var(--sw-text)",
              }
        }
      >
        {errorText && <div className="p-[var(--sw-space-3)]">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
