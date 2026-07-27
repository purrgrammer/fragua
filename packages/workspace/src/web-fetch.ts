// web_fetch — fetch a single URL and return its content as raw
// markdown. Marked `defaultDisabled: true` so workflows that don't
// explicitly list it in `allowed_tools` never see it.
//
// Behavior:
//   - HTTP auto-upgrades to HTTPS.
//   - Same-host redirects followed up to MAX_REDIRECTS hops.
//   - Cross-host redirects return the redirect URL as a hint to
//     re-call (defense-in-depth — keeps the LLM in control of which
//     hosts get hit).
//   - 401/403 → returns a hint to use an authenticated MCP tool
//     instead. For GitHub specifically, prefer `gh` CLI via bash.
//   - 15-minute in-memory cache keyed by URL.
//   - HTML → markdown via turndown with a heuristic extraction pass
//     (nav / header / footer / aside / forms / data: URIs dropped)
//     so the character cap buys real content, not chrome.
//   - Non-HTML bodies (JSON, plain text) pass through unconverted.
//   - Output is head-truncated to RAW_MAX_CHARS; `truncated: true`
//     tells the caller the tail was dropped.

import { Type } from "@sinclair/typebox";
import TurndownService from "turndown";
import type { Tool, ToolOutput } from "./types.ts";

// Sole cap on the returned markdown. ~12K tokens / call — keeps a
// burst of fetches from blowing downstream context while still
// returning the full head of most pages.
const RAW_MAX_CHARS = 50_000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  ts: number;
  result: ToolOutput<unknown>;
}

const cache = new Map<string, CacheEntry>();

function pruneCache(now: number): void {
  for (const [k, v] of cache) {
    if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
  }
}

/** Test-only: the module-level cache is process-global, so suites that
 *  reuse a URL must clear it between cases. */
export function _resetWebFetchCacheForTests(): void {
  cache.clear();
}

interface WebFetchArgs {
  url: string;
}

export const webFetchTool: Tool<WebFetchArgs, Record<string, unknown>> = {
  name: "web_fetch",
  description:
    "Fetch a single URL and return its content as raw markdown (HTML is converted, non-content chrome " +
    "like nav/header/footer stripped; JSON and plain text pass through unchanged). Deterministic and free — " +
    "no model call. Output is head-truncated at ~50KB / ~12K tokens; `truncated: true` signals the tail was " +
    "dropped. Will fail on authenticated/private URLs (Google Docs, Confluence, Jira, private GitHub) — " +
    "prefer an MCP tool for those. For GitHub specifically, prefer `gh` CLI via bash " +
    "(`gh pr view`, `gh issue view`, `gh api`) over web_fetch.",
  parameters: Type.Object({
    url: Type.String({ description: "Fully-formed URL. HTTP auto-upgrades to HTTPS." }),
  }),
  // Repeat calls with the same URL hit the cache. The externally-
  // observable behaviour (read a remote URL, return its markdown) is
  // read-only by design, so idempotent=true keeps dangling-call resume
  // from forcing human approval.
  idempotent: true,
  truncation: { max_chars: RAW_MAX_CHARS, mode: "head_tail" },
  defaultDisabled: true,

  async execute(args, _env, opts = {}) {
    const ctx = opts.fraguaContext;
    const signal = opts.signal;
    const httpFetch = ctx?.http?.fetch ?? globalThis.fetch.bind(globalThis);

    let target: URL;
    try {
      target = new URL(args.url);
    } catch {
      return errorResult(`invalid URL: ${args.url}`);
    }
    let upgradedFromHttp = false;
    if (target.protocol === "http:") {
      target = new URL(target.toString().replace(/^http:/, "https:"));
      upgradedFromHttp = true;
    }
    if (target.protocol !== "https:") {
      return errorResult(`unsupported protocol: ${target.protocol}`);
    }

    const now = Date.now();
    pruneCache(now);
    const cacheKey = target.toString();
    const hit = cache.get(cacheKey);
    if (hit) {
      const ageSec = Math.round((now - hit.ts) / 1000);
      const cachedText =
        hit.result.content?.[0]?.type === "text" ? `${hit.result.content[0].text}\n\n[cached ${ageSec}s ago]` : "";
      return {
        text: cachedText,
        content: [{ type: "text", text: cachedText }],
        data: { ...((hit.result.data as Record<string, unknown>) ?? {}), cached: true, age_seconds: ageSec },
      };
    }

    let current = target;
    let response: Response | undefined;
    let html = "";
    let contentType = "";
    let resolvedUrl = current.toString();

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        response = await httpFetch(current.toString(), {
          redirect: "manual",
          ...(signal ? { signal } : {}),
          headers: {
            "user-agent": "fragua-web-fetch/0",
            accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.8",
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (signal?.aborted) return errorResult(`fetch aborted: ${message}`);
        return errorResult(`fetch failed for ${current.toString()}: ${message}`);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          return errorResult(`redirect ${response.status} with no Location header at ${current.toString()}`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return errorResult(`malformed Location header "${location}" at ${current.toString()}`);
        }
        if (next.host !== current.host) {
          const text =
            `Cross-host redirect: ${current.host} → ${next.host}.\n\n` +
            `Re-call web_fetch with this URL to continue:\n\n${next.toString()}`;
          return {
            text,
            content: [{ type: "text", text }],
            data: { url: current.toString(), cross_host_redirect: next.toString(), status: response.status },
          };
        }
        if (hop === MAX_REDIRECTS) {
          return errorResult(`exceeded ${MAX_REDIRECTS} redirects starting at ${target.toString()}`);
        }
        current = next;
        continue;
      }

      resolvedUrl = current.toString();
      contentType = response.headers.get("content-type") ?? "";
      try {
        html = await response.text();
      } catch (err) {
        return errorResult(
          `failed to read body of ${resolvedUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      break;
    }

    if (!response) {
      return errorResult(`no response after redirect loop for ${target.toString()}`);
    }

    if (response.status === 401 || response.status === 403) {
      return errorResult(
        `${resolvedUrl} returned ${response.status} — looks like an authenticated/private URL. ` +
          "Prefer an MCP tool, or for GitHub, the gh CLI via bash (e.g. `gh pr view`, `gh issue view`, `gh api`).",
      );
    }
    if (response.status >= 400) {
      return errorResult(`${resolvedUrl} returned HTTP ${response.status}`);
    }

    const isHtml = /text\/html|application\/xhtml/i.test(contentType) || html.trim().startsWith("<");
    const fullMarkdown = isHtml ? htmlToMarkdown(html) : html;
    if (fullMarkdown.trim().length === 0) {
      return errorResult(`${resolvedUrl} returned empty content after HTML→markdown conversion`);
    }

    const truncated = fullMarkdown.length > RAW_MAX_CHARS;
    const text = truncated
      ? `${fullMarkdown.slice(0, RAW_MAX_CHARS)}\n\n[…truncated, ${fullMarkdown.length - RAW_MAX_CHARS} chars omitted from tail]`
      : fullMarkdown;
    const data: Record<string, unknown> = {
      url: resolvedUrl,
      cached: false,
      upgraded_from_http: upgradedFromHttp,
      truncated,
      input_chars: fullMarkdown.length,
    };
    const result: ToolOutput<Record<string, unknown>> = {
      text,
      content: [{ type: "text", text }],
      data,
    };
    cache.set(cacheKey, { ts: now, result });
    return result;
  },
};

const REMOVE_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "svg",
  "button",
  "head",
  "link",
  "meta",
  "title",
]);
const REMOVE_ROLES = new Set(["navigation", "banner", "contentinfo"]);

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.remove((node) => {
    const name = typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "";
    if (REMOVE_TAGS.has(name)) return true;
    if (typeof node.getAttribute !== "function") return false;
    const role = node.getAttribute("role");
    if (role && REMOVE_ROLES.has(role.toLowerCase())) return true;
    if (node.getAttribute("aria-hidden") === "true") return true;
    return false;
  });
  return cleanMarkdown(td.turndown(html));
}

function isJunkLine(line: string): boolean {
  const t = line.trim();
  if (t === "") return false;
  if (/^[-*+]$/.test(t)) return true;
  if (/^!?\[\s*\]\(\s*\)$/.test(t)) return true;
  if (/^\[\s*\]$/.test(t)) return true;
  if (/^\(\s*\)$/.test(t)) return true;
  if (/^[|•·]+$/.test(t)) return true;
  return false;
}

function cleanMarkdown(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\(\s*data:[^)]*\)/gi, "")
    .replace(/\[([^\]]*)\]\(\s*data:[^)]*\)/gi, "$1")
    .split("\n")
    .filter((line) => !isJunkLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function errorResult(message: string): ToolOutput<Record<string, unknown>> {
  return {
    text: message,
    content: [{ type: "text", text: message }],
    is_error: true,
    data: { error: message },
  };
}
