// Pins the FileViewer's content-type → renderer dispatch so a server
// MIME-table change surfaces in CI rather than as a silent UI
// regression. Each test stubs `fetch` so the per-file query resolves
// to canned bytes + content-type.

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { useDom } from "../../../test/setup.ts";
import { FileViewer } from "./file-viewer.tsx";

function installFileFetch(bytes: Uint8Array, contentType: string): void {
  globalThis.fetch = (async (_input: RequestInfo | URL) => {
    return new Response(bytes as BlobPart, {
      status: 200,
      headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
    });
  }) as typeof fetch;
}

function renderWithClient(ui: JSX.Element) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const enc = new TextEncoder();

describe("FileViewer", () => {
  useDom();
  afterEach(() => cleanup());

  test("shows a placeholder when no file is selected", () => {
    const { container } = renderWithClient(<FileViewer locId="x" path={null} />);
    expect(within(container).getByTestId("file-viewer-empty")).toBeTruthy();
  });

  test("text/markdown → raw text viewer", async () => {
    installFileFetch(enc.encode("# heading\n\nbody"), "text/markdown; charset=utf-8");
    const { container } = renderWithClient(<FileViewer locId="x" path="SKILL.md" />);
    const text = await waitFor(() => within(container).getByTestId("file-viewer-text"));
    expect(text.textContent).toContain("# heading");
    // No markdown-rendered pane — raw source only.
    expect(within(container).queryByTestId("file-viewer-markdown")).toBeNull();
  });

  test("text/plain → monospace text viewer", async () => {
    installFileFetch(enc.encode("import sys\nprint('hi')\n"), "text/plain; charset=utf-8");
    const { container } = renderWithClient(<FileViewer locId="x" path="scripts/util.py" />);
    const text = await waitFor(() => within(container).getByTestId("file-viewer-text"));
    expect(text.textContent).toContain("import sys");
  });

  test("image/* → image viewer", async () => {
    // Tiny PNG header — enough to assert the dispatch path.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    installFileFetch(png, "image/png");
    const { container } = renderWithClient(<FileViewer locId="x" path="assets/hero.png" />);
    expect(await waitFor(() => within(container).getByTestId("file-viewer-image"))).toBeTruthy();
  });

  test("unknown content type → hex-dump", async () => {
    // Eight bytes; one row of hex-dump output, no truncation banner.
    const blob = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x41, 0x42, 0x43, 0x44]);
    installFileFetch(blob, "application/octet-stream");
    const { container } = renderWithClient(<FileViewer locId="x" path="weird.bin" />);
    const hex = await waitFor(() => within(container).getByTestId("file-viewer-hex"));
    // Hex-dump output: offset, hex bytes, then ASCII gutter ("ABCD" for 0x41–0x44).
    expect(hex.textContent).toContain("00000000");
    expect(hex.textContent).toContain("00 01 02 03 41 42 43 44");
    expect(hex.textContent).toContain("ABCD");
    // No truncation for an 8-byte payload.
    expect(within(container).queryByTestId("file-viewer-hex-truncated")).toBeNull();
  });

  test("hex-dump shows truncation banner past the 4 KB cap", async () => {
    const big = new Uint8Array(5000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    installFileFetch(big, "application/octet-stream");
    const { container } = renderWithClient(<FileViewer locId="x" path="big.bin" />);
    await waitFor(() => within(container).getByTestId("file-viewer-hex"));
    expect(within(container).queryByTestId("file-viewer-hex-truncated")).toBeTruthy();
  });
});
