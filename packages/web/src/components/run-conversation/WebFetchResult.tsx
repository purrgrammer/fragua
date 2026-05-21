// Custom rendering for the `web_fetch` core tool. Slots into
// <ToolContent>'s output area when toolName === "web_fetch" inside
// RichToolResult. Result shape is produced by
// `packages/workspace/src/web-fetch.ts`.

import type { ToolResultMessage } from "@fragua/types";
import { CircleAlertIcon, ExternalLinkIcon, Globe } from "lucide-react";
import type { JSX, ReactNode } from "react";

interface WebFetchParams {
  url: string;
  prompt: string;
}

interface WebFetchData {
  url?: string;
  mode?: "raw" | "summarise";
  cached?: boolean;
  upgraded_from_http?: boolean;
  truncated?: boolean;
  cross_host_redirect?: string;
  error?: string;
  provider?: string;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  duration_ms?: number;
  input_chars?: number;
}

const SECTION_LABEL = "font-medium uppercase text-[length:var(--sw-text-xs)] text-[var(--sw-muted)] tracking-[0.06em]";
const PANEL =
  "rounded-[var(--sw-radius-default)] border border-[var(--sw-border)] bg-[var(--sw-surface)] " +
  "px-[var(--sw-space-3)] py-[var(--sw-space-2)] text-[length:var(--sw-text-xs)]";

function firstText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") return b.text;
    }
  }
  return "";
}

function formatCost(usd: number | undefined): string | null {
  if (typeof usd !== "number" || usd === 0) return null;
  if (usd < 0.001) return `$${(usd * 1000).toFixed(2)}m`;
  return `$${usd.toFixed(4)}`;
}

function formatDuration(ms: number | undefined): string | null {
  if (typeof ms !== "number") return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(input: number | undefined, output: number | undefined): string | null {
  if (typeof input !== "number" && typeof output !== "number") return null;
  return `${input ?? 0}↑ ${output ?? 0}↓ tok`;
}

function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

export interface WebFetchResultProps {
  params?: Partial<WebFetchParams> | undefined;
  result: ToolResultMessage | undefined;
  isStreaming: boolean;
}

export function WebFetchResult({ params, result, isStreaming }: WebFetchResultProps): JSX.Element {
  const url = (result?.details as WebFetchData | undefined)?.url ?? params?.url;

  if (isStreaming || !result) {
    return (
      <div className={PANEL}>
        <div className="flex items-center gap-[var(--sw-space-2)]">
          <Globe className="size-3.5 sw-pulse" style={{ color: "var(--sw-accent-thinking)" }} />
          <span className="font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">
            fetching {truncateMid(url ?? "…", 80)}
          </span>
        </div>
        {params?.prompt ? (
          <div className="mt-[var(--sw-space-1)] text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">
            <span className="opacity-70">prompt: </span>
            {params.prompt}
          </div>
        ) : null}
      </div>
    );
  }

  const data = (result.details ?? {}) as WebFetchData;
  const text = firstText(result.content);
  const isError = result.isError === true || (data.error !== undefined && data.error !== null);
  const isRedirect = typeof data.cross_host_redirect === "string";

  if (isError) {
    return (
      <div
        className={
          "rounded-[var(--sw-radius-default)] border " +
          "px-[var(--sw-space-3)] py-[var(--sw-space-2)] " +
          "text-[length:var(--sw-text-xs)]"
        }
        style={{
          borderColor: "color-mix(in oklch, var(--sw-accent-error) 30%, transparent)",
          backgroundColor: "color-mix(in oklch, var(--sw-accent-error) 8%, transparent)",
          color: "var(--sw-accent-error)",
        }}
      >
        <div className="mb-[var(--sw-space-1)] flex items-center gap-[var(--sw-space-2)]">
          <CircleAlertIcon className="size-3.5" />
          <span className="font-medium">web_fetch failed</span>
          {url ? <UrlPill url={url} /> : null}
        </div>
        <div className="whitespace-pre-wrap font-mono">{data.error ?? text}</div>
      </div>
    );
  }

  if (isRedirect && typeof data.cross_host_redirect === "string") {
    return (
      <div
        className={
          "rounded-[var(--sw-radius-default)] border " +
          "px-[var(--sw-space-3)] py-[var(--sw-space-2)] " +
          "text-[length:var(--sw-text-xs)]"
        }
        style={{
          borderColor: "color-mix(in oklch, var(--sw-accent-warn) 30%, transparent)",
          backgroundColor: "color-mix(in oklch, var(--sw-accent-warn) 6%, transparent)",
        }}
      >
        <div className="mb-[var(--sw-space-2)] flex items-center gap-[var(--sw-space-2)]">
          <ExternalLinkIcon className="size-3.5" style={{ color: "var(--sw-accent-warn)" }} />
          <span className="font-medium" style={{ color: "var(--sw-accent-warn)" }}>
            Cross-host redirect
          </span>
          {url ? <UrlPill url={url} /> : null}
        </div>
        <div className="text-[var(--sw-muted)]">Re-call web_fetch with this URL to follow:</div>
        <a
          href={data.cross_host_redirect}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-[var(--sw-space-1)] block break-all font-mono text-[length:var(--sw-text-xs)] hover:underline"
          style={{ color: "var(--sw-accent-warn)" }}
        >
          {data.cross_host_redirect}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-[var(--sw-space-2)]">
      <div className="flex flex-wrap items-center gap-[var(--sw-space-2)]">
        <h4 className={SECTION_LABEL}>Result</h4>
        {url ? <UrlPill url={url} /> : null}
        {data.mode === "raw" ? <Badge tone="muted">raw markdown</Badge> : null}
        {data.cached ? <Badge tone="muted">cached</Badge> : null}
        {data.upgraded_from_http ? <Badge tone="muted">https↑</Badge> : null}
        {data.truncated ? <Badge tone="warn">truncated</Badge> : null}
      </div>
      {params?.prompt ? (
        <div className="text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">
          <span className="opacity-70">prompt: </span>
          {params.prompt}
        </div>
      ) : null}
      <div className={PANEL}>
        <div className="whitespace-pre-wrap text-[length:var(--sw-text)] text-[var(--sw-text)]">{text}</div>
      </div>
      <Footer data={data} />
    </div>
  );
}

function UrlPill({ url }: { url: string }): JSX.Element {
  const display = (() => {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname.length > 1 ? u.pathname : ""}`;
    } catch {
      return url;
    }
  })();
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-[2px] rounded-[var(--sw-radius-default)] border border-[var(--sw-border)] px-[var(--sw-space-1)] py-[1px] font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)] hover:text-[var(--sw-text)]"
      title={url}
    >
      <Globe className="size-3" />
      {truncateMid(display, 60)}
    </a>
  );
}

function Badge({ tone, children }: { tone: "muted" | "warn"; children: ReactNode }): JSX.Element {
  const color = tone === "warn" ? "var(--sw-accent-warn)" : "var(--sw-muted)";
  return (
    <span
      className="inline-flex items-center rounded-[var(--sw-radius-default)] border px-[var(--sw-space-1)] py-[1px] text-[length:var(--sw-text-xs)] uppercase tracking-[0.06em]"
      style={{ borderColor: color, color }}
    >
      {children}
    </span>
  );
}

function Footer({ data }: { data: WebFetchData }): JSX.Element | null {
  const parts: string[] = [];
  if (data.provider && data.model) parts.push(`${data.provider}/${data.model}`);
  const tok = formatTokens(data.input_tokens, data.output_tokens);
  if (tok) parts.push(tok);
  const dur = formatDuration(data.duration_ms);
  if (dur) parts.push(dur);
  const cost = formatCost(data.cost_usd);
  if (cost) parts.push(cost);
  if (typeof data.input_chars === "number" && data.input_chars > 0) {
    parts.push(`${Math.round(data.input_chars / 1024)}KB md`);
  }
  if (parts.length === 0) return null;
  return <div className="font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">{parts.join("  ·  ")}</div>;
}
