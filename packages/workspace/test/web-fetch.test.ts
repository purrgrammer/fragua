import { describe, expect, test } from "bun:test";
import { isPrivateAddress } from "../src/ssrf-guard.ts";
import { createWebFetchTool } from "../src/tools.ts";
import { LocalEnvironment } from "../src/local-env.ts";

type FetchFn = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

function mockFetch(response: {
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
  url?: string;
}): { fetch: FetchFn; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchFn = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    const headers = new Headers();
    if (response.contentType) headers.set("content-type", response.contentType);
    return new Response(response.body ?? "", {
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      headers,
    });
  };
  return { fetch, calls };
}

// Pretend every hostname resolves to a public IP so the SSRF guard allows the fetch.
const publicLookup = async () => [{ address: "93.184.216.34" }]; // example.com

const env = new LocalEnvironment({ cwd: process.cwd() });

describe("isPrivateAddress", () => {
  test("rejects loopback, link-local, RFC1918, IPv6 equivalents", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true); // AWS metadata
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("172.16.1.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("0.0.0.0")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("accepts public addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});

describe("local:web_fetch", () => {
  test("rejects non-http(s) schemes", async () => {
    const { fetch, calls } = mockFetch({});
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    const r = await tool.execute({ url: "file:///etc/passwd" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("refused scheme");
    expect(calls.length).toBe(0);
  });

  test("rejects loopback IP literal", async () => {
    const { fetch, calls } = mockFetch({});
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    const r = await tool.execute({ url: "http://127.0.0.1/secrets" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("private/loopback");
    expect(calls.length).toBe(0);
  });

  test("rejects AWS metadata endpoint", async () => {
    const { fetch, calls } = mockFetch({});
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    const r = await tool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, env);
    expect(r.is_error).toBe(true);
    expect(calls.length).toBe(0);
  });

  test("rejects hostname that resolves to a private IP", async () => {
    const { fetch, calls } = mockFetch({});
    const tool = createWebFetchTool({ fetch, lookup: async () => [{ address: "10.0.0.5" }] });
    const r = await tool.execute({ url: "https://evil.example.com/" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("10.0.0.5");
    expect(calls.length).toBe(0);
  });

  test("sends Accept header preferring markdown", async () => {
    const { fetch, calls } = mockFetch({ contentType: "text/markdown", body: "# hello" });
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    await tool.execute({ url: "https://example.com/docs" }, env);
    expect(calls[0]?.init?.headers).toBeDefined();
    const headers = new Headers(calls[0]?.init?.headers as HeadersInit);
    expect(headers.get("accept")).toContain("text/markdown");
  });

  test("text/markdown responses pass through unchanged", async () => {
    const { fetch } = mockFetch({ contentType: "text/markdown; charset=utf-8", body: "# Title\n\nBody" });
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    const r = await tool.execute({ url: "https://example.com/" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toBe("# Title\n\nBody");
    expect((r.data as { converted: boolean }).converted).toBe(false);
  });

  test("text/html is converted to markdown", async () => {
    const { fetch } = mockFetch({
      contentType: "text/html",
      body: "<html><body><h1>Title</h1><p>Body <a href='https://x.test'>link</a>.</p><script>alert(1)</script></body></html>",
    });
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    const r = await tool.execute({ url: "https://example.com/" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toContain("# Title");
    expect(r.text).toContain("Body");
    expect(r.text).toContain("[link](https://x.test)");
    expect(r.text).not.toContain("alert(1)");
    expect((r.data as { converted: boolean }).converted).toBe(true);
  });

  test("format: raw skips HTML conversion", async () => {
    const { fetch } = mockFetch({ contentType: "text/html", body: "<h1>Title</h1>" });
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    const r = await tool.execute({ url: "https://example.com/", format: "raw" }, env);
    expect(r.is_error).toBeUndefined();
    expect(r.text).toBe("<h1>Title</h1>");
    expect((r.data as { converted: boolean }).converted).toBe(false);
  });

  test("non-2xx response reports is_error", async () => {
    const { fetch } = mockFetch({ status: 404, statusText: "Not Found", contentType: "text/plain", body: "nope" });
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    const r = await tool.execute({ url: "https://example.com/missing" }, env);
    expect(r.is_error).toBe(true);
    expect(r.text).toContain("HTTP 404");
  });

  test("data payload reports status and content_type", async () => {
    const { fetch } = mockFetch({ status: 200, contentType: "text/plain", body: "plain" });
    const tool = createWebFetchTool({ fetch, lookup: publicLookup });
    const r = await tool.execute({ url: "https://example.com/" }, env);
    const data = r.data as { status: number; content_type: string; converted: boolean };
    expect(data.status).toBe(200);
    expect(data.content_type).toBe("text/plain");
    expect(data.converted).toBe(false);
  });
});
