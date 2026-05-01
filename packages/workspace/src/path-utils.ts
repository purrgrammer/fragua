import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const UNICODE_SPACES = /[  -   　]/g;
const NARROW_NO_BREAK_SPACE = " ";

function normalizeUnicodeSpaces(s: string): string {
  return s.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

export function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
  if (normalized === "~") return homedir();
  if (normalized.startsWith("~/")) return homedir() + normalized.slice(1);
  return normalized;
}

export function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (isAbsolute(expanded)) return expanded;
  return resolve(cwd, expanded);
}

function fileExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** macOS screenshot filenames embed a narrow no-break space (U+202F)
 * before AM/PM. Users typing the path usually substitute a regular
 * space — try that variant before giving up. */
function tryMacOSScreenshotPath(path: string): string {
  return path.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

/** macOS uses U+2019 (right single quotation mark) in localized
 * screenshot names like "Capture d'écran"; users type the straight
 * apostrophe (U+0027). */
function tryCurlyQuoteVariant(path: string): string {
  return path.replace(/'/g, "’");
}

/** Resolve a read path with macOS-friendly fallbacks: NFD normalization
 * (HFS+/APFS store filenames decomposed), AM/PM screenshot fix-up,
 * curly-quote substitution, and the combined NFD-plus-curly-quote
 * variant. Returns the original resolved path when no variant exists,
 * so callers still get a meaningful error. */
export function resolveReadPath(filePath: string, cwd: string): string {
  const resolved = resolveToCwd(filePath, cwd);
  if (fileExists(resolved)) return resolved;

  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && fileExists(amPmVariant)) return amPmVariant;

  const nfdVariant = resolved.normalize("NFD");
  if (nfdVariant !== resolved && fileExists(nfdVariant)) return nfdVariant;

  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && fileExists(curlyVariant)) return curlyVariant;

  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) return nfdCurlyVariant;

  return resolved;
}

const fileMutationQueues = new Map<string, Promise<void>>();

function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

/** Serialize file mutations targeting the same path. Operations on
 * different paths still run in parallel. The key is the realpath so
 * symlinks pointing at the same inode share a queue. */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = getMutationQueueKey(filePath);
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((r) => {
    releaseNext = r;
  });
  const chainedQueue = currentQueue.then(() => nextQueue);
  fileMutationQueues.set(key, chainedQueue);

  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Detect a supported image MIME type by extension *and* magic-byte
 * sniff. Returns null for non-image content even if the extension
 * suggests one (so a `.png` file containing JSON doesn't get sent as
 * a corrupt image to the model). The sniff covers the four formats
 * pi-ai accepts: JPEG, PNG, GIF, WebP. */
export function detectImageMimeType(buffer: Buffer, path: string): string | null {
  const ext = extractExtension(path).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  if (buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  // GIF: 47 49 46 38 (37|39) 61
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  // Extension matches but bytes don't — fall back to extension MIME so
  // the model still gets a usable hint. The provider will reject if
  // the bytes are truly invalid.
  return EXT_TO_MIME[ext] ?? null;
}

function extractExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "";
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot < slash) return "";
  return path.slice(dot);
}
