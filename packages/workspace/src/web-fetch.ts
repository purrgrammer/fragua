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
//     (nav / aside / forms / data: URIs dropped; header / footer
//     dropped only when NOT inside an article/main/section, so
//     titles and bylines survive) so the character cap buys real
//     content, not chrome. Pages the full pass zeroes out are retried
//     with a minimal strip set before erroring.
//   - Non-HTML bodies (JSON, plain text) pass through unconverted.
//   - The response body is read streamingly and the stream cancelled at
//     BODY_MAX_CHARS; output is then head-truncated to RAW_MAX_CHARS and
//     `truncated: true` tells the caller the tail was dropped.

import { Type } from "@sinclair/typebox";
import TurndownService from "turndown";
import type { Tool, ToolOutput } from "./types.ts";

// Sole cap on the returned markdown. ~12K tokens / call — keeps a
// burst of fetches from blowing downstream context while still
// returning the full head of most pages.
const RAW_MAX_CHARS = 50_000;
// Hard cap on how much of the response body we read at all — comfortably
// above any real article, far below a heap risk. The stream is cancelled
// once it's reached, so an endless or oversized body neither buffers nor
// keeps downloading. Not `truncated`: that stays "the returned markdown
// was cut", computed downstream against RAW_MAX_CHARS.
const BODY_MAX_CHARS = 2_000_000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  ts: number;
  /** The markdown head with NO notices appended. Caching the rendered text
   *  instead would stack a second footer onto an already-annotated string on
   *  every hit, so the head is stored clean and the notices re-applied at
   *  return time. */
  head: string;
  /** Characters dropped from the tail; 0 when the page fit under the cap. */
  omitted: number;
  data: Record<string, unknown>;
}

/** Compose the returned text: the markdown head plus whichever notices apply. */
function renderText(head: string, omitted: number, ageSec?: number): string {
  const notes: string[] = [];
  if (omitted > 0) notes.push(`[…truncated, ${omitted} chars omitted from tail]`);
  if (ageSec !== undefined) notes.push(`[cached ${ageSec}s ago]`);
  return notes.length > 0 ? `${head}\n\n${notes.join("\n")}` : head;
}

// Hostnames and literal addresses that name the machine fragua runs on, or the
// network it sits inside. The tool fetches whatever URL a model hands it, and a
// model reading a fetched page can be talked into handing over another one, so
// the reachable surface has to stop at the public internet.
//
// LIMIT, deliberate: this checks the URL's own hostname. A public name that
// RESOLVES to a private address still passes — closing that needs the resolved
// IP checked on every hop, which `fetch` does not expose, and even then races
// its own DNS lookup. This bars the direct forms (literal IPs, `localhost`,
// `.internal`); it is not a rebinding defense.
const PRIVATE_HOST_SUFFIXES = [".local", ".internal", ".localhost"];

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "::") return true;
  if (PRIVATE_HOST_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) carries the v4 address in its tail.
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }
  // Unique-local (fc00::/7) and link-local (fe80::/10) v6.
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

// Bounds the cache so a run fetching many distinct URLs inside the TTL window
// can't retain them all — each entry holds up to RAW_MAX_CHARS of markdown.
const MAX_CACHE_ENTRIES = 256;

const cache = new Map<string, CacheEntry>();

/** Drop the oldest entries until there is room for one more. Insertion order is
 *  Map iteration order and entries are written once, so the first key is the
 *  oldest — no scan for a minimum. */
function evictOldest(): void {
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) return;
    cache.delete(oldest.value);
  }
}

function pruneCache(now: number): void {
  for (const [k, v] of cache) {
    if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
  }
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
    if (isPrivateHost(target.hostname)) {
      return errorResult(`refusing to fetch ${target.toString()} — private or loopback address`);
    }

    const now = Date.now();
    pruneCache(now);
    const cacheKey = target.toString();
    const hit = cache.get(cacheKey);
    if (hit) {
      const ageSec = Math.round((now - hit.ts) / 1000);
      const text = renderText(hit.head, hit.omitted, ageSec);
      return {
        text,
        content: [{ type: "text", text }],
        data: { ...hit.data, cached: true, age_seconds: ageSec },
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
          return errorResult(`malformed Location header at ${current.toString()}`);
        }
        if (next.protocol !== "https:") {
          // Deliberately does NOT name the destination: handing back a
          // downgraded URL just invites the model to re-call it. Pinned by
          // "rejects a redirect that downgrades to http, without offering it
          // as a hint".
          return errorResult(`unsupported protocol: ${next.protocol}`);
        }
        if (isPrivateHost(next.hostname)) {
          // Named, unlike the downgrade above — an https host is not a URL the
          // model is being nudged to retry, and the operator needs to see which
          // internal host a page tried to reach.
          return errorResult(`redirect to ${next.host} refused — private or loopback address`);
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
        html = await readBodyCapped(response, BODY_MAX_CHARS);
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
    // Conversion walks attacker-supplied markup: turndown recurses over the
    // parsed tree, so markup nested past the engine's stack depth throws a
    // RangeError. Everything else here reports failure as a tool result, and
    // the adapter rethrows anything that isn't a PathEscapeError — an escaping
    // throw would surface as an unstructured node failure instead.
    let fullMarkdown: string;
    try {
      fullMarkdown = isHtml ? htmlToMarkdown(html, "full") : html;
      // The full extraction pass can zero out SPA shells and nav-only
      // landing pages. Retry once with a minimal strip set before giving
      // up, so those pages return their residual text instead of a hard
      // error.
      if (isHtml && fullMarkdown.trim().length === 0) {
        fullMarkdown = htmlToMarkdown(html, "minimal");
      }
    } catch (err) {
      return errorResult(
        `failed to convert ${resolvedUrl} to markdown: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (fullMarkdown.trim().length === 0) {
      return errorResult(`${resolvedUrl} returned empty content${isHtml ? " after HTML→markdown conversion" : ""}`);
    }

    const truncated = fullMarkdown.length > RAW_MAX_CHARS;
    const omitted = truncated ? fullMarkdown.length - RAW_MAX_CHARS : 0;
    const head = truncated ? fullMarkdown.slice(0, RAW_MAX_CHARS) : fullMarkdown;
    const text = renderText(head, omitted);
    const data: Record<string, unknown> = {
      url: resolvedUrl,
      cached: false,
      upgraded_from_http: upgradedFromHttp,
      truncated,
      // Pre-cap length: what the page converted to. `returned_chars` is what the
      // model actually received — on a truncated page the two differ, and it is
      // the second one that answers "how much context did this cost".
      input_chars: fullMarkdown.length,
      returned_chars: head.length,
    };
    evictOldest();
    cache.set(cacheKey, { ts: now, head, omitted, data });
    return { text, content: [{ type: "text", text }], data };
  },
};

/** Read at most `max` characters of the body, then cancel the stream —
 *  `response.text()` would buffer the whole thing first, so an oversized
 *  or endless body has to be cut off at the source, not after. */
async function readBodyCapped(response: Response, max: number): Promise<string> {
  const body = response.body;
  if (!body) return (await response.text()).slice(0, max);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.slice(0, max);
}

// Always dropped, in every strip mode — never real content.
const MINIMAL_REMOVE_TAGS = new Set(["script", "style", "noscript", "iframe", "head", "link", "meta", "title"]);
// Site chrome dropped by the full extraction pass. `header`/`footer` are
// NOT here: they're removed conditionally (see hasContentAncestor) so a
// title/byline block inside an <article>/<main>/<section> survives.
const FULL_REMOVE_TAGS = new Set([...MINIMAL_REMOVE_TAGS, "nav", "aside", "form", "svg", "button"]);
const REMOVE_ROLES = new Set(["navigation", "banner", "contentinfo"]);
const CONTENT_ANCESTORS = new Set(["article", "main", "section"]);

interface DomNodeLike {
  nodeName?: unknown;
  parentNode?: DomNodeLike | null;
  getAttribute?: (name: string) => string | null;
}

function nodeName(node: DomNodeLike): string {
  return typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "";
}

/** Turndown hands the filter every node, including ones without an
 *  element API (text, comments), so the accessor has to be guarded. */
function attr(node: DomNodeLike, name: string): string | null {
  return typeof node.getAttribute === "function" ? node.getAttribute(name) : null;
}

/** Ancestor hops to walk before giving up. The walk runs per header/footer
 *  node, so on deeply-nested markup its cost is node count × depth: 5000
 *  nested elements measured ~876ms of synchronous, un-abortable work, against
 *  ~428ms with this bound. Set far above any real document's nesting so the
 *  cap only ever engages on pathological markup — a header that genuinely
 *  sits 256 levels inside an <article> does not occur, and one that deep is
 *  treated as chrome. */
const MAX_ANCESTOR_HOPS = 256;

/** True when the node sits inside an <article>/<main>/<section>. A
 *  header/footer there is structural page content (title, byline,
 *  footnotes), not site chrome, so it must survive. */
function hasContentAncestor(node: DomNodeLike): boolean {
  let p = node.parentNode ?? null;
  for (let hops = 0; p && hops < MAX_ANCESTOR_HOPS; hops++) {
    if (CONTENT_ANCESTORS.has(nodeName(p))) return true;
    p = p.parentNode ?? null;
  }
  return false;
}

function hasDataUri(node: DomNodeLike, name: string): boolean {
  return attr(node, name)?.trim().toLowerCase().startsWith("data:") ?? false;
}

function htmlToMarkdown(html: string, strip: "full" | "minimal"): string {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  const removeTags = strip === "full" ? FULL_REMOVE_TAGS : MINIMAL_REMOVE_TAGS;
  td.remove((node) => {
    const name = nodeName(node);
    if (removeTags.has(name)) return true;
    if (strip !== "full") return false;
    if ((name === "header" || name === "footer") && !hasContentAncestor(node)) return true;
    // `role` is a space-separated list and may carry surrounding whitespace, so
    // a raw `has()` on the whole attribute misses `role=" navigation "` and
    // `role="navigation main"` — both of which are still site chrome.
    const roles = attr(node, "role")?.toLowerCase().trim().split(/\s+/) ?? [];
    return roles.some((r) => REMOVE_ROLES.has(r)) || attr(node, "aria-hidden") === "true";
  });
  // Drop data: URI images and unwrap data: URI anchors at the DOM layer
  // (via addRule, which outranks turndown's built-in image/link rules) —
  // regexing them out of the markdown after the fact mishandles URIs
  // containing a literal `)` (inline SVG, CSS url(...)).
  td.addRule("stripDataImg", {
    filter: (node) => nodeName(node) === "img" && hasDataUri(node, "src"),
    replacement: () => "",
  });
  td.addRule("stripDataHref", {
    filter: (node) => nodeName(node) === "a" && hasDataUri(node, "href"),
    replacement: (content) => content,
  });
  return cleanMarkdown(td.turndown(html));
}

// One junk token: a label-less link or image (icon nav rows, alt-less
// figures), an empty paren pair, a bare separator glyph, or run of
// whitespace. `-` and `*` are absent because turndown escapes a lone one
// (`\-`, `\*`); it does not escape `+`. The href arm accepts an escaped
// paren (`\(`) because turndown escapes parens inside a URL rather than
// dropping them.
//
// Matched as a repeated *token* rather than as one whole-line regex. The
// whole-line form needs a `+` over an alternation whose arms are
// individually quantified and mutually ambiguous (`[]()` parses as either
// the link arm or the empty-paren arm), which backtracks exponentially —
// and every byte here comes from a fetched page. A line of ~30 `+`
// characters cost ~800ms, so a 31 KB page of them blocked the event loop
// for ~13 minutes, synchronously and past any abort signal. Leftmost-
// greedy tokenisation has no such cliff: the arms are disjoint on their
// first character, so each position matches at most one and the scan is
// linear.
// `replace()`-only. A `/g` regex carries `lastIndex`, but `String.replace`
// always scans from 0 and resets it — reaching for `.test()` or `.exec()` here
// instead would make consecutive calls skip lines.
const JUNK_TOKEN = /!?\[\s*\](?:\((?:\\.|[^)\\])*\))?|\(\s*\)|[|•·+]|\s+/g;

function isJunkLine(line: string): boolean {
  return line.length > 0 && line.replace(JUNK_TOKEN, "").length === 0;
}

function cleanMarkdown(md: string): string {
  return md
    .split("\n")
    .filter((line) => !isJunkLine(line.trim()))
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
