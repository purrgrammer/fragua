// web_fetch — fetch a single URL, convert HTML → markdown, run a
// prompt against the content with the configured small/fast
// summariser model. Marked `defaultDisabled: true` so workflows that
// don't explicitly list it in `allowed_tools` never see it.
//
// Behavior:
//   - HTTP auto-upgrades to HTTPS.
//   - Same-host redirects followed up to MAX_REDIRECTS hops.
//   - Cross-host redirects return the redirect URL as a hint to
//     re-call (defense-in-depth — keeps the LLM in control of which
//     hosts get hit).
//   - 401/403 → returns a hint to use an authenticated MCP tool
//     instead. For GitHub specifically, prefer `gh` CLI via bash.
//   - 15-minute in-memory cache keyed by (url, prompt).
//   - HTML → markdown via turndown, capped at MAX_INPUT_CHARS.
//   - Markdown is fed to the configured summariser (via
//     `opts.swarmContext.summarise`) with the user's prompt as a
//     `system_prompt_override`.

import { Type } from "@sinclair/typebox";
import TurndownService from "turndown";
import type { Tool, ToolOutput } from "./types.ts";

const MAX_INPUT_CHARS = 200_000;
// Raw-markdown return cap when the caller skips summarisation (no
// `prompt`). Smaller than MAX_INPUT_CHARS to keep token cost in check
// when downstream nodes consume `$nodeId.output`. ~12K tokens / call.
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

interface WebFetchArgs {
  url: string;
  prompt?: string;
}

export const webFetchTool: Tool<WebFetchArgs, Record<string, unknown>> = {
  name: "web_fetch",
  description:
    "Fetch a single URL, convert HTML to markdown. Two modes: " +
    "(1) Pass `prompt` to extract specific information via the configured small/fast summariser model — " +
    "compact output (~1K tokens), small summariser cost. " +
    "(2) Omit `prompt` to receive the raw markdown directly — higher fidelity, no summariser cost, " +
    "larger token footprint (capped at ~50KB / ~12K tokens, head-truncated). " +
    "Use raw mode when the caller (workflow node, downstream synthesise step) needs the full content " +
    "to reason across sources. Will fail on authenticated/private URLs (Google Docs, Confluence, " +
    "Jira, private GitHub) — prefer an MCP tool for those. For GitHub specifically, prefer `gh` CLI via bash " +
    "(`gh pr view`, `gh issue view`, `gh api`) over web_fetch.",
  parameters: Type.Object({
    url: Type.String({ description: "Fully-formed URL. HTTP auto-upgrades to HTTPS." }),
    prompt: Type.Optional(
      Type.String({
        description:
          "Optional. Pass to extract specific information via the configured summariser. Omit to receive the raw markdown content (no summariser cost).",
      }),
    ),
  }),
  // Repeat calls with the same (url, prompt) hit the cache; absent the
  // cache, the summariser model can produce slightly different text on
  // each invocation, but the externally-observable behaviour (read a
  // remote URL, return a focused extract) is idempotent in spirit.
  // Marking idempotent=true keeps dangling-call resume from forcing
  // human approval on a tool that's read-only by design.
  idempotent: true,
  // Tool's text output is the model's response — already small (≤1024
  // tokens by construction). Truncation policy mostly a no-op but
  // matches the workspace shape.
  truncation: { max_chars: MAX_INPUT_CHARS, mode: "tail" },
  defaultDisabled: true,

  async execute(args, _env, opts = {}) {
    const ctx = opts.swarmContext;
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

    const isRawMode = args.prompt === undefined || args.prompt.length === 0;
    const now = Date.now();
    pruneCache(now);
    // Cache key separates raw vs summarise variants — same URL with
    // different prompts gets distinct entries.
    const cacheKey = `${target.toString()}\0${args.prompt ?? ""}`;
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

    // Summarise mode requires a configured summariser; raw mode does
    // not (the markdown is returned verbatim, no LLM call).
    if (!isRawMode && !ctx?.summarise) {
      return errorResult(
        "web_fetch with `prompt` requires a configured summariser, but none is wired to this daemon. " +
          "Either omit `prompt` for raw markdown, or set `defaults.summariser.{llm_provider,llm_model}` in .swarm/config.yaml.",
      );
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
            "user-agent": "swarm-web-fetch/0",
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

    if (isRawMode) {
      // No summariser call. Return the markdown verbatim, head-truncated
      // to RAW_MAX_CHARS so a fanout of fetches doesn't blow downstream
      // context. The caller (workflow node, agent) sees the full content
      // up to the cap and decides what to do with it.
      const truncated = fullMarkdown.length > RAW_MAX_CHARS;
      const text = truncated
        ? `${fullMarkdown.slice(0, RAW_MAX_CHARS)}\n\n[…truncated, ${fullMarkdown.length - RAW_MAX_CHARS} chars omitted from tail]`
        : fullMarkdown;
      const data: Record<string, unknown> = {
        url: resolvedUrl,
        mode: "raw",
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
    }

    // Summarise mode: feed up to MAX_INPUT_CHARS of markdown to the
    // configured small/fast summariser with the user's `prompt` as a
    // system prompt override.
    let markdown = fullMarkdown;
    let truncated = false;
    if (markdown.length > MAX_INPUT_CHARS) {
      markdown = markdown.slice(0, MAX_INPUT_CHARS);
      truncated = true;
    }

    // ctx + ctx.summarise both verified above for the non-raw branch.
    if (!ctx?.summarise) {
      return errorResult("internal: summariser unset reached the summarise branch");
    }
    const summarisation = await ctx.summarise({
      purpose: "thread",
      input: markdown,
      run_id: ctx.runId,
      workflow_sha: "",
      synthetic_node_id: `__web_fetch.${ctx.nodeId}`,
      caller_node_id: ctx.nodeId,
      max_output_tokens: 1024,
      ...(signal ? { signal } : {}),
      system_prompt_override:
        `You are a web-page reader. The user has provided a markdown rendering of a web page. ` +
        `Run their query against the page content faithfully. If the page does not contain the requested ` +
        `information, say so explicitly — never fabricate details that aren't in the source.\n\n` +
        `User query:\n${args.prompt}`,
    });

    if (!summarisation.ok) {
      return errorResult(`summariser failed: ${summarisation.error ?? "unknown error"}. URL: ${resolvedUrl}`);
    }

    const responseText = summarisation.text.trim();
    const data: Record<string, unknown> = {
      url: resolvedUrl,
      mode: "summarise",
      cached: false,
      upgraded_from_http: upgradedFromHttp,
      truncated,
      input_chars: markdown.length,
      provider: summarisation.provider,
      model: summarisation.model,
      input_tokens: summarisation.input_tokens,
      output_tokens: summarisation.output_tokens,
      cost_usd: summarisation.cost_usd,
      duration_ms: summarisation.duration_ms,
    };

    const result: ToolOutput<Record<string, unknown>> = {
      text: responseText,
      content: [{ type: "text", text: responseText }],
      data,
    };
    cache.set(cacheKey, { ts: now, result });
    return result;
  },
};

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  td.remove(["script", "style", "noscript", "iframe"]);
  return td.turndown(html);
}

function errorResult(message: string): ToolOutput<Record<string, unknown>> {
  return {
    text: message,
    content: [{ type: "text", text: message }],
    is_error: true,
    data: { error: message },
  };
}
