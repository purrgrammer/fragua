import type { ToolResultMessage } from "@fragua/types";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { WebFetchResult } from "./WebFetchResult.tsx";

function redirectResult(redirect: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "web_fetch",
    content: [{ type: "text", text: "Cross-host redirect" }],
    details: { url: "https://a.example/start", cross_host_redirect: redirect },
    isError: false,
    timestamp: 0,
  };
}

/** An error result: the tool omits `url` from `details` on every error
 *  path, so the pill falls back to the raw argument the model supplied. */
function errorResult(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "web_fetch",
    content: [{ type: "text", text: "unsupported protocol: javascript:" }],
    details: { error: "unsupported protocol: javascript:" },
    isError: true,
    timestamp: 0,
  };
}

describe("WebFetchResult URL pill", () => {
  afterEach(() => cleanup());

  test("renders a rejected javascript: argument as inert text, never an href", () => {
    const evil = "javascript:alert(document.cookie)";
    const { container } = render(<WebFetchResult params={{ url: evil }} result={errorResult()} isStreaming={false} />);
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).not.toContain(evil);
    expect(container.textContent).toContain(evil);
  });

  test("still links an https URL", () => {
    const url = "https://ok.example/page";
    const { container } = render(<WebFetchResult params={{ url }} result={errorResult()} isStreaming={false} />);
    expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toContain(url);
  });
});

describe("WebFetchResult cross-host redirect rendering", () => {
  afterEach(() => cleanup());

  test("renders an https redirect as a clickable anchor", () => {
    const dest = "https://b.example/landing";
    const { container } = render(<WebFetchResult result={redirectResult(dest)} isStreaming={false} />);
    const anchor = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === dest);
    expect(anchor).toBeTruthy();
  });

  test("renders a javascript: redirect as plain text, never an href", () => {
    const evil = "javascript:alert(document.cookie)";
    const { container } = render(<WebFetchResult result={redirectResult(evil)} isStreaming={false} />);
    const anchors = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(anchors).not.toContain(evil);
    expect(container.textContent).toContain(evil);
  });
});
