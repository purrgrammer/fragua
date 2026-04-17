// Command blocklist — refuses the most dangerous shell patterns even in
// unsafe permission mode. Each entry is a regex source tested case-insensitively.

export const DEFAULT_BLOCKED_PATTERNS: readonly string[] = [
  // rm -rf against critical paths
  "\\brm\\s+-[a-z]*r[a-z]*f?[a-z]*\\s+(/|~|\\.\\.?|\\*)(\\s|$)",
  // sudo anything
  "\\bsudo\\b",
  // pipe a download into a shell
  "\\b(curl|wget)\\b[^\\n]*\\|\\s*(sh|bash|zsh|fish)\\b",
  // force-push to main/master
  "\\bgit\\s+push\\s+(-f|--force)\\s+\\S+\\s+(main|master)\\b",
  // mkfs / dd to a block device
  "\\bmkfs\\.",
  "\\bdd\\s+.*of=/dev/",
  // fork bomb
  ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:",
];

/** Return the first pattern that matches, or undefined if command is allowed. */
export function isBlockedCommand(command: string, extra: readonly string[] = []): string | undefined {
  const all = [...DEFAULT_BLOCKED_PATTERNS, ...extra];
  for (const src of all) {
    try {
      if (new RegExp(src, "i").test(command)) return src;
    } catch {
      // Invalid regex → fall back to literal substring match
      if (command.toLowerCase().includes(src.toLowerCase())) return src;
    }
  }
  return undefined;
}
