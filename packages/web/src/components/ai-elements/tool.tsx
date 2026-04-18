"use client";

import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  BotIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  FilePlusIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderIcon,
  type LucideIcon,
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

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group not-prose mb-4 w-full rounded-md border", className)} {...props} />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

const statusLabels: Record<ToolPart["state"], string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-violet-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-4" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolPart["state"]) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

/** Built-in swarm tool registry — header icon + human-readable label,
 * keyed by canonical `domain:name` (see `packages/workspace/src/tools.ts`).
 * Unknown tools fall back to a generic wrench and a title-cased slug. */
interface ToolPresentation {
  icon: LucideIcon;
  label: string;
}

export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  "local:bash": { icon: TerminalIcon, label: "Bash" },
  "local:read_file": { icon: FileTextIcon, label: "Read File" },
  "local:write_file": { icon: FilePlusIcon, label: "Write File" },
  "local:edit_file": { icon: PencilIcon, label: "Edit File" },
  "local:list_dir": { icon: FolderIcon, label: "List Directory" },
  "local:glob": { icon: FileSearchIcon, label: "Glob" },
  "local:grep": { icon: SearchIcon, label: "Grep" },
  "local:subagent": { icon: BotIcon, label: "Subagent" },
};

/** Resolve a tool name to its registry entry. Accepts either the
 * canonical `local:bash` form or the AI-SDK slug (`tool-local_bash`)
 * emitted by `toolTypeFromName`. Only the first underscore is the
 * domain separator — tool names themselves may contain underscores
 * (e.g. `read_file`), so a blanket `_`→`:` replace is wrong. */
function lookupTool(toolName: string | undefined): ToolPresentation | undefined {
  if (!toolName) return undefined;
  const direct = TOOL_PRESENTATION[toolName];
  if (direct) return direct;
  const stripped = toolName.replace(/^tool-/, "");
  const sep = stripped.indexOf("_");
  if (sep !== -1) {
    const canonical = `${stripped.slice(0, sep)}:${stripped.slice(sep + 1)}`;
    return TOOL_PRESENTATION[canonical];
  }
  return undefined;
}

/** Title-case an unknown tool's name part so `custom:do_thing` renders
 * as "Do Thing" instead of leaking the raw slug. */
function humanizeToolName(toolName: string): string {
  const stripped = toolName.replace(/^tool-/, "");
  const namePart = stripped.includes(":") ? stripped.split(":").slice(1).join(":") : stripped;
  return namePart
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export const ToolHeader = ({ className, title, type, state, toolName, ...props }: ToolHeaderProps) => {
  const derivedName = type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");
  // `title` carries the canonical tool name (e.g. `local:bash`) when the
  // caller has it; fall back to the derived slug. Look up the registry
  // for icon + human-readable label, and humanize unknown tools.
  const raw = title ?? derivedName;
  const entry = lookupTool(raw);
  const Icon = entry?.icon ?? WrenchIcon;
  const label = entry?.label ?? humanizeToolName(raw);

  return (
    <CollapsibleTrigger className={cn("flex w-full items-center justify-between gap-4 p-3", className)} {...props}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{label}</span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-2 px-4 pt-2 pb-1 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Parameters</h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
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

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
