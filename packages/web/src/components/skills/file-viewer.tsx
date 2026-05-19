// Per-file viewer for SkillDetail. Dispatches on the server-asserted
// Content-Type:
//   text/* (incl. markdown) → raw monospace text
//   image/*                 → inline <img> from a blob URL
//   everything else         → 16-bytes-per-row hex-dump capped at 4 KB
//
// Lazy-loaded via tanstack-query; cache key is `(locId, path)` so
// re-mounting / clicking back to a file is O(1).

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../lib/api.ts";
import { queries } from "../../lib/queries.ts";

export interface FileViewerProps {
  locId: string;
  /** Path relative to skill_dir, posix-separated. Null = empty pane. */
  path: string | null;
}

const HEX_DUMP_BYTE_CAP = 4096;

export function FileViewer({ locId, path }: FileViewerProps): JSX.Element {
  if (path === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-sw-muted" data-testid="file-viewer-empty">
        Select a file to view.
      </div>
    );
  }
  return <Loaded locId={locId} path={path} />;
}

function Loaded({ locId, path }: { locId: string; path: string }): JSX.Element {
  const { data, isPending, isError, error } = useQuery(queries.skills.file(locId, path));

  if (isPending) {
    return (
      <div className="p-4 text-sm text-sw-muted" data-testid="file-viewer-loading">
        Loading <code className="font-mono">{path}</code>…
      </div>
    );
  }
  if (isError) {
    const msg = error instanceof ApiError ? `${error.status}` : error instanceof Error ? error.message : String(error);
    return (
      <div className="p-4 text-sm text-sw-accent-error" data-testid="file-viewer-error">
        Failed to load: {msg}
      </div>
    );
  }
  return <Dispatch path={path} bytes={data.bytes} contentType={data.contentType} />;
}

function Dispatch({ path, bytes, contentType }: { path: string; bytes: Uint8Array; contentType: string }): JSX.Element {
  const ct = contentType.split(";", 1)[0]?.toLowerCase().trim() ?? "";
  if (ct.startsWith("image/")) return <ImageView path={path} bytes={bytes} contentType={contentType} />;
  if (ct.startsWith("text/") || ct === "application/json") return <TextView path={path} bytes={bytes} />;
  return <HexDump path={path} bytes={bytes} />;
}

function ImageView({
  path,
  bytes,
  contentType,
}: {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // Construct a blob URL from the bytes so the <img> renders without
    // a second HTTP round-trip; revoke on unmount to keep memory tidy.
    const blob = new Blob([bytes as BlobPart], { type: contentType });
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
    };
  }, [bytes, contentType]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer-image">
      <Toolbar path={path} />
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {url && <img src={url} alt={path} className="max-w-full" />}
      </div>
    </div>
  );
}

function TextView({ path, bytes }: { path: string; bytes: Uint8Array }): JSX.Element {
  const text = useMemo(() => new TextDecoder("utf-8").decode(bytes), [bytes]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer-text">
      <Toolbar path={path} />
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <pre className="font-mono text-xs text-sw-text">{text}</pre>
      </div>
    </div>
  );
}

function HexDump({ path, bytes }: { path: string; bytes: Uint8Array }): JSX.Element {
  const truncated = bytes.length > HEX_DUMP_BYTE_CAP;
  const slice = useMemo(() => bytes.slice(0, HEX_DUMP_BYTE_CAP), [bytes]);
  const rows = useMemo(() => {
    const out: { offset: string; hex: string; ascii: string }[] = [];
    for (let i = 0; i < slice.length; i += 16) {
      const chunk = slice.slice(i, Math.min(i + 16, slice.length));
      const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0")).join(" ");
      const ascii = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
      out.push({ offset: i.toString(16).padStart(8, "0"), hex, ascii });
    }
    return out;
  }, [slice]);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer-hex">
      <Toolbar path={path}>
        <span className="font-mono text-xs text-sw-muted">{bytes.length} bytes</span>
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <pre className="font-mono text-xs text-sw-text">
          {rows.map((r) => (
            <div key={r.offset} className="whitespace-pre">
              <span className="text-sw-muted">{r.offset}</span> {r.hex.padEnd(48, " ")} {r.ascii}
            </div>
          ))}
        </pre>
        {truncated && (
          <p className="mt-3 text-xs text-sw-muted" data-testid="file-viewer-hex-truncated">
            Truncated to first {HEX_DUMP_BYTE_CAP} bytes of {bytes.length}.
          </p>
        )}
      </div>
    </div>
  );
}

function Toolbar({ path, children }: { path: string; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between border-b border-sw-border px-4 py-2">
      <code className="truncate font-mono text-xs text-sw-muted" title={path} data-testid="file-viewer-path">
        {path}
      </code>
      {children}
    </div>
  );
}
