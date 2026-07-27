// The 15-minute result cache is module-global and there is no
// production reset hook, so every case mints its URL through `freshUrl`
// — uniqueness is structural, not a convention a copy-pasted test can
// silently break by reusing a hostname and exercising the cache instead
// of its stub. Only the cache case reuses a URL, and it does so on
// purpose.

import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, FraguaToolContext } from "../src/types.ts";
import { webFetchTool } from "../src/web-fetch.ts";

interface StubSpec {
  status?: number;
  contentType?: string;
  body?: string;
  location?: string;
}

function stubFetch(routes: Record<string, StubSpec>): typeof globalThis.fetch {
  return (async (input: string | URL) => {
    const url = input.toString();
    const spec = routes[url];
    if (!spec) throw new Error(`no stub for ${url}`);
    const headers = new Headers();
    if (spec.contentType) headers.set("content-type", spec.contentType);
    if (spec.location) headers.set("location", spec.location);
    return new Response(spec.body ?? "", { status: spec.status ?? 200, headers });
  }) as typeof globalThis.fetch;
}

function ctx(fetch: typeof globalThis.fetch): FraguaToolContext {
  return { runId: "r", nodeId: "n", iteration: 0, http: { fetch }, emit: () => {} };
}

const env = {} as unknown as ExecutionEnvironment;

let urlCounter = 0;
function freshUrl(name: string): string {
  urlCounter += 1;
  return `https://${name}-${urlCounter}.example/page`;
}

async function run(url: string, fetch: typeof globalThis.fetch) {
  return webFetchTool.execute({ url }, env, { fraguaContext: ctx(fetch) });
}

describe("web_fetch", () => {
  test("strips nav/header/footer/aside, keeps the article body", async () => {
    const url = freshUrl("strip");
    const html =
      "<html><body>" +
      '<nav><a href="/">Home</a><a href="/about">About Us</a></nav>' +
      "<header>Site Header Banner</header>" +
      "<article><h1>Real Article Title</h1><p>The genuine article body paragraph.</p></article>" +
      "<aside>Sidebar promo links</aside>" +
      "<footer>Copyright 2024 Example Corp</footer>" +
      "</body></html>";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    expect(res.is_error).toBeUndefined();
    expect(res.text).toContain("Real Article Title");
    expect(res.text).toContain("genuine article body paragraph");
    expect(res.text).not.toContain("Site Header Banner");
    expect(res.text).not.toContain("Sidebar promo links");
    expect(res.text).not.toContain("Copyright 2024 Example Corp");
    expect(res.text).not.toContain("About Us");
  });

  test("keeps a header inside an article (title/byline survive)", async () => {
    const url = freshUrl("structured");
    const html =
      "<html><body>" +
      "<article><header><h1>Real Article Title</h1><span>by Jane Byline</span></header>" +
      "<p>The genuine article body paragraph.</p></article>" +
      "</body></html>";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    expect(res.is_error).toBeUndefined();
    expect(res.text).toContain("Real Article Title");
    expect(res.text).toContain("Jane Byline");
  });

  test("strips a page-level header/footer outside any article", async () => {
    const url = freshUrl("chrome");
    const html =
      "<html><body>" +
      "<header>Global Site Banner</header>" +
      "<main><p>The genuine main content.</p></main>" +
      "<footer>Global Site Footer</footer>" +
      "</body></html>";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    expect(res.is_error).toBeUndefined();
    expect(res.text).toContain("genuine main content");
    expect(res.text).not.toContain("Global Site Banner");
    expect(res.text).not.toContain("Global Site Footer");
  });

  test("falls back to a minimal strip pass instead of erroring on chrome-only pages", async () => {
    const url = freshUrl("spa");
    // Everything real is site chrome the full pass drops; the only text
    // lives inside a <nav>, so the full extraction pass zeroes out.
    const html = "<html><body><nav><p>App shell loading indicator text.</p></nav></body></html>";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    expect(res.is_error).toBeUndefined();
    expect(res.text).toContain("App shell loading indicator text.");
  });

  test("errors with an HTML-specific message only for HTML bodies", async () => {
    const url = freshUrl("empty");
    const res = await run(url, stubFetch({ [url]: { contentType: "text/plain", body: "   " } }));

    expect(res.is_error).toBe(true);
    expect(res.text).toContain("empty content");
    expect(res.text).not.toContain("HTML\u2192markdown");
  });

  test("drops label-less link lines but keeps a bare dash paragraph", async () => {
    const url = freshUrl("junk");
    const html =
      "<html><body><article>" +
      "<p>Body before.</p>" +
      '<p><a href="/icon"></a></p>' +
      '<p><img src="/spacer.gif" alt=""></p>' +
      "<p>-</p>" +
      "<p>Body after.</p>" +
      "</article></body></html>";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    const lines = res.text.split("\n").map((l) => l.trim());
    expect(lines).toContain("Body before.");
    expect(lines).toContain("Body after.");
    // A lone-dash paragraph survives; turndown escapes it as `\-`.
    expect(lines).toContain("\\-");
    expect(res.text).not.toContain("/icon");
    expect(res.text).not.toContain("spacer.gif");
  });

  test("drops an orphaned + bullet, keeps an escaped * paragraph", async () => {
    // The two are asymmetric only because turndown escapes a lone `*`
    // (to `\*`) and does not escape a lone `+`. Both halves are asserted
    // so a turndown upgrade that changes either escape rule fails here
    // rather than silently altering what the filter eats.
    const url = freshUrl("markers");
    const html = "<html><body><article><p>A</p><p>+</p><p>*</p><p>B</p></article></body></html>";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    const lines = res.text.split("\n").map((l) => l.trim());
    expect(lines).toContain("A");
    expect(lines).toContain("B");
    expect(lines).not.toContain("+");
    expect(lines).toContain("\\*");
  });

  test("drops a label-less link whose href contains parentheses", async () => {
    const url = freshUrl("parens");
    const html =
      "<html><body><article>" +
      "<p>Body before.</p>" +
      '<p><a href="/wiki/foo_(bar)"></a></p>' +
      "<p>Body after.</p>" +
      "</article></body></html>";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    expect(res.text).toContain("Body before.");
    expect(res.text).toContain("Body after.");
    expect(res.text).not.toContain("wiki");
  });

  test("drops a data: URI image from the output", async () => {
    const url = freshUrl("data-uri");
    const html =
      "<html><body><article>" +
      "<p>Before the image.</p>" +
      '<img alt="huge" src="data:image/png;base64,AAAABBBBCCCCDDDDEEEEFFFF">' +
      "<p>After the image.</p>" +
      "</article></body></html>";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    expect(res.text).toContain("Before the image.");
    expect(res.text).toContain("After the image.");
    expect(res.text).not.toContain("data:");
    expect(res.text).not.toContain("base64");
  });

  test("truncates content over the cap and keeps the head", async () => {
    const url = freshUrl("big");
    const filler = "AAAAAAAAAA".repeat(6000); // 60_000 chars > RAW_MAX_CHARS (50_000)
    const html = `<html><body><article><p>HEADMARKER ${filler} TAILMARKER</p></article></body></html>`;
    const res = await run(url, stubFetch({ [url]: { contentType: "text/html", body: html } }));

    const data = res.data as Record<string, unknown>;
    expect(data["truncated"]).toBe(true);
    expect(typeof data["input_chars"]).toBe("number");
    expect(data["input_chars"] as number).toBeGreaterThan(50_000);
    expect(res.text.startsWith("HEADMARKER")).toBe(true);
    expect(res.text).toContain("truncated");
    expect(res.text).not.toContain("TAILMARKER");
  });

  test("stops reading and cancels the stream at the body cap", async () => {
    const url = freshUrl("endless");
    const chunk = new TextEncoder().encode("A".repeat(100_000));
    let cancelled = false;
    let pulls = 0;
    const fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/plain" } },
      )) as unknown as typeof globalThis.fetch;

    const res = await run(url, fetch);

    expect(cancelled).toBe(true);
    // BODY_MAX_CHARS is 2_000_000 — the stream would otherwise never end.
    expect((res.data as Record<string, unknown>)["input_chars"]).toBe(2_000_000);
    expect(pulls).toBeLessThan(30);
  });

  test("passes JSON through unconverted", async () => {
    const url = freshUrl("api");
    const body = '{"key":"value","nested":{"n":1}}';
    const res = await run(url, stubFetch({ [url]: { contentType: "application/json", body } }));

    expect(res.is_error).toBeUndefined();
    expect(res.text).toBe(body);
    expect((res.data as Record<string, unknown>)["truncated"]).toBe(false);
  });

  test("passes plain text through unconverted", async () => {
    const url = freshUrl("plain");
    const body = "Just plain text.\nSecond line with * asterisk and _underscore_.";
    const res = await run(url, stubFetch({ [url]: { contentType: "text/plain", body } }));

    expect(res.text).toBe(body);
  });

  test("returns a hint for a cross-host redirect rather than following", async () => {
    const url = freshUrl("a");
    const dest = "https://b.example/landing";
    const res = await run(url, stubFetch({ [url]: { status: 302, location: dest } }));

    expect(res.is_error).toBeUndefined();
    const data = res.data as Record<string, unknown>;
    expect(data["cross_host_redirect"]).toBe(dest);
    expect(res.text).toContain("Cross-host redirect");
  });

  test("rejects a javascript: redirect Location without populating cross_host_redirect", async () => {
    const url = freshUrl("evil-redirect");
    const res = await run(url, stubFetch({ [url]: { status: 302, location: "javascript:alert(document.cookie)" } }));

    expect(res.is_error).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data["cross_host_redirect"]).toBeUndefined();
  });

  test("rejects a redirect that downgrades to http, without offering it as a hint", async () => {
    // The initial target auto-upgrades http→https; a redirect does not.
    // A hint would just hand the model a downgraded URL to re-call.
    const url = freshUrl("downgrade");
    const res = await run(url, stubFetch({ [url]: { status: 302, location: "http://downgrade.example/landing" } }));

    expect(res.is_error).toBe(true);
    expect(res.text).toContain("unsupported protocol");
    expect((res.data as Record<string, unknown>)["cross_host_redirect"]).toBeUndefined();
  });

  test("returns the authenticated-URL hint on 401/403", async () => {
    const url401 = freshUrl("auth");
    const res401 = await run(url401, stubFetch({ [url401]: { status: 401, body: "nope" } }));
    expect(res401.is_error).toBe(true);
    expect(res401.text).toContain("authenticated/private");
    expect(res401.text).toContain("gh");

    const url403 = freshUrl("forbidden");
    const res403 = await run(url403, stubFetch({ [url403]: { status: 403, body: "nope" } }));
    expect(res403.is_error).toBe(true);
    expect(res403.text).toContain("authenticated/private");
  });

  test("marks a repeat fetch of the same URL as cached", async () => {
    const url = freshUrl("cache");
    const html = "<html><body><article><p>Cacheable content here.</p></article></body></html>";
    const fetch = stubFetch({ [url]: { contentType: "text/html", body: html } });

    const first = await run(url, fetch);
    expect((first.data as Record<string, unknown>)["cached"]).toBe(false);

    const second = await run(url, fetch);
    const data = second.data as Record<string, unknown>;
    expect(data["cached"]).toBe(true);
    expect(typeof data["age_seconds"]).toBe("number");
    expect(second.text).toContain("Cacheable content here.");
  });
});
