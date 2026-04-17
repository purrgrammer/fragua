// Env-leak gate — scan a .env file for secrets before registering a codebase.
// Cheap security floor: catches the single most common accidental credential
// commit vector.

const SECRET_KEY_PATTERNS: readonly RegExp[] = [
  /_API_KEY$/i,
  /_SECRET$/i,
  /_TOKEN$/i,
  /_PASSWORD$/i,
  /_CREDENTIAL$/i,
  /_CREDENTIALS$/i,
  /_KEY$/i, // catches e.g. PRIVATE_KEY
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^OPENROUTER_/i,
  /^GEMINI_/i,
  /^GOOGLE_API_KEY$/i,
  /^AWS_/i,
  /^AZURE_/i,
];

/** Names that look sensitive but commonly appear empty / placeholder. Skip. */
const SAFE_PLACEHOLDERS: readonly string[] = ["", "<changeme>", "xxx", "placeholder", "your-key-here"];

export interface EnvLeak {
  line: number;
  name: string;
  /** Redacted preview (first 4 chars of the value + length). */
  preview: string;
}

/** Parse a .env file and return every secret-looking key with a non-empty value. */
export function scanDotenv(contents: string): EnvLeak[] {
  const leaks: EnvLeak[] = [];
  const lines = contents.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const stripped = raw.trim();
    if (stripped === "" || stripped.startsWith("#")) continue;
    const eqIdx = stripped.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = stripped.slice(0, eqIdx).trim();
    let value = stripped.slice(eqIdx + 1).trim();
    // Strip matched surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (SAFE_PLACEHOLDERS.includes(value.toLowerCase())) continue;
    if (!SECRET_KEY_PATTERNS.some((p) => p.test(name))) continue;
    leaks.push({
      line: i + 1,
      name,
      preview: `${value.slice(0, 4)}…(${value.length} chars)`,
    });
  }
  return leaks;
}

/** Format a leak list for CLI output. */
export function formatLeaks(leaks: EnvLeak[]): string {
  if (leaks.length === 0) return "";
  const rows = leaks.map((l) => `  line ${l.line}: ${l.name}=${l.preview}`);
  return [
    `found ${leaks.length} secret-looking entr${leaks.length === 1 ? "y" : "ies"} in .env:`,
    ...rows,
    "",
    "If you trust this codebase and know what you're doing, rerun with --allow-env-keys.",
    "Otherwise move the secrets to a local-only file (e.g. .env.local, ~/.config/...) and retry.",
  ].join("\n");
}
