export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateHead(content: string, options?: TruncationOptions): TruncationResult {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  if (Buffer.byteLength(allLines[0]!, "utf-8") > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
      maxLines,
      maxBytes,
    };
  }

  let outputLines = 0;
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < allLines.length; i++) {
    const lineBytes = Buffer.byteLength(allLines[i]!, "utf-8");
    const separatorBytes = i > 0 ? 1 : 0;
    const nextBytes = outputBytes + separatorBytes + lineBytes;

    if (nextBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    if (i >= maxLines) {
      truncatedBy = "lines";
      break;
    }

    outputBytes = nextBytes;
    outputLines = i + 1;
  }

  const truncatedContent = allLines.slice(0, outputLines).join("\n");

  return {
    content: truncatedContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines,
    outputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

export function truncateTail(content: string, options?: TruncationOptions): TruncationResult {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const allLines = content.split("\n");
  const totalLines = allLines.length;

  if (totalBytes <= maxBytes && totalLines <= maxLines) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines,
      maxBytes,
    };
  }

  let outputLines = 0;
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  const lastLinePartial = false;

  for (let i = allLines.length - 1; i >= 0; i--) {
    const lineBytes = Buffer.byteLength(allLines[i]!, "utf-8");
    const separatorBytes = i < allLines.length - 1 ? 1 : 0;
    const nextBytes = outputBytes + separatorBytes + lineBytes;

    if (nextBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLines === 0) {
        const lastLine = allLines[i]!;
        const partial = truncateLineToBytes(lastLine, maxBytes);
        return {
          content: partial,
          truncated: true,
          truncatedBy: "bytes",
          totalLines,
          totalBytes,
          outputLines: 1,
          outputBytes: Buffer.byteLength(partial, "utf-8"),
          lastLinePartial: true,
          firstLineExceedsLimit: false,
          maxLines,
          maxBytes,
        };
      }
      break;
    }

    if (allLines.length - i > maxLines) {
      truncatedBy = "lines";
      break;
    }

    outputBytes = nextBytes;
    outputLines += 1;
  }

  const startIndex = allLines.length - outputLines;
  const truncatedContent = allLines.slice(startIndex).join("\n");

  return {
    content: truncatedContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines,
    outputBytes,
    lastLinePartial,
    firstLineExceedsLimit: false,
    maxLines,
    maxBytes,
  };
}

export function truncateLine(line: string, maxChars = 500): { text: string; wasTruncated: boolean } {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, maxChars)}[truncated]`, wasTruncated: true };
}

function truncateLineToBytes(line: string, maxBytes: number): string {
  const buf = Buffer.from(line, "utf-8");
  if (buf.length <= maxBytes) return line;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf-8");
}
