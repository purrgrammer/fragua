// Custom rendering for the `web_fetch` core tool. Slots into
// <ToolContent>'s output area when toolName === "web_fetch" inside
// RichToolResult. Result shape is produced by
// `packages/workspace/src/web-fetch.ts`.

import type { ToolResultMessage } from "@fragua/types";
import { CircleAlertIcon, ExternalLinkIcon, Globe } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { firstText, PANEL, SECTION_LABEL, toolData } from "./tool-result-helpers.ts";

interface WebFetchData {
  url?: string;
  cached?: boolean;
  upgraded_from_http?: boolean;
  truncated?: boolean;
  cross_host_redirect?: string;
  error?: string;
  input_chars?: number;
}

/** `http:` is accepted alongside `https:` because the log is append-only:
 *  runs recorded before the tool started rejecting non-https redirects
 *  still render. Anything else stays inert text, never an href. */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

export interface WebFetchResultProps {
  params?: { url?: string } | undefined;
  result: ToolResultMessage | undefined;
  isStreaming: boolean;
}

export function WebFetchResult({ params, result, isStreaming }: WebFetchResultProps): JSX.Element {
  const url = toolData<WebFetchData>(result).url ?? params?.url;

  if (isStreaming || !result) {
    return (
      <div className={PANEL}>
        <div className="flex items-center gap-[var(--sw-space-2)]">
          <Globe className="size-3.5 sw-pulse" style={{ color: "var(--sw-accent-thinking)" }} />
          <span className="font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">
            fetching {truncateMid(url ?? "…", 80)}
          </span>
        </div>
      </div>
    );
  }

  const data = toolData<WebFetchData>(result);
  const text = firstText(result.content);
  const isError = result.isError === true || (data.error !== undefined && data.error !== null);
  const redirect = data.cross_host_redirect;

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

  if (typeof redirect === "string") {
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
        {isHttpUrl(redirect) ? (
          <a
            href={redirect}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-[var(--sw-space-1)] block break-all font-mono text-[length:var(--sw-text-xs)] hover:underline"
            style={{ color: "var(--sw-accent-warn)" }}
          >
            {redirect}
          </a>
        ) : (
          <div
            className="mt-[var(--sw-space-1)] block break-all font-mono text-[length:var(--sw-text-xs)]"
            style={{ color: "var(--sw-accent-warn)" }}
          >
            {redirect}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-[var(--sw-space-2)]">
      <div className="flex flex-wrap items-center gap-[var(--sw-space-2)]">
        <h4 className={SECTION_LABEL}>Result</h4>
        {url ? <UrlPill url={url} /> : null}
        {data.cached ? <Badge tone="muted">cached</Badge> : null}
        {data.upgraded_from_http ? <Badge tone="muted">https↑</Badge> : null}
        {data.truncated ? <Badge tone="warn">truncated</Badge> : null}
      </div>
      <div className={PANEL}>
        <div className="whitespace-pre-wrap text-[length:var(--sw-text)] text-[var(--sw-text)]">{text}</div>
      </div>
      <Footer data={data} />
    </div>
  );
}

const PILL =
  "inline-flex items-center gap-[2px] rounded-[var(--sw-radius-default)] border border-[var(--sw-border)] px-[var(--sw-space-1)] py-[1px] font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]";

function UrlPill({ url }: { url: string }): JSX.Element {
  // On every error path the tool omits `url` from its result, so this
  // falls back to the raw argument the model asked for — which the tool
  // may have rejected precisely because it wasn't http(s). A live href
  // there would put a `javascript:` URL one click away on every replay.
  // Such a URL is shown verbatim, scheme included: `new URL()` parses it
  // happily and host/pathname would render it as bare `alert(…)`, hiding
  // the very thing an operator is looking at the pill to see.
  if (!isHttpUrl(url)) {
    return (
      <span className={PILL} title={url}>
        <Globe className="size-3" />
        {truncateMid(url, 60)}
      </span>
    );
  }
  const u = new URL(url);
  const display = `${u.host}${u.pathname.length > 1 ? u.pathname : ""}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={`${PILL} hover:text-[var(--sw-text)]`}
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
  if (typeof data.input_chars === "number" && data.input_chars > 0) {
    // Sub-KB pages round to "0KB md", which reads as an empty fetch. Show the
    // character count instead — example.com is ~180 chars and a real result.
    const chars = data.input_chars;
    parts.push(chars < 1024 ? `${chars} chars md` : `${Math.round(chars / 1024)}KB md`);
  }
  if (parts.length === 0) return null;
  return <div className="font-mono text-[length:var(--sw-text-xs)] text-[var(--sw-muted)]">{parts.join("  ·  ")}</div>;
}
