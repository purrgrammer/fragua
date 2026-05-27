// Base credential patterns for the secret scrubber.
// Registry-independent: each pattern catches secrets by shape alone,
// regardless of which literal credentials are loaded into the registry.
// Pure module — no I/O, no clock, no random.

export const BASE_PATTERNS: ReadonlyArray<{ source: string; re: RegExp }> = [
  {
    source: "pattern:anthropic_key",
    re: /sk-ant-[A-Za-z0-9_-]{20,}/,
  },
  {
    source: "pattern:openai_key",
    re: /sk-(proj-)?[A-Za-z0-9_-]{20,}/,
  },
  {
    source: "pattern:github_token",
    re: /gh[posu]_[A-Za-z0-9]{36,}/,
  },
  {
    source: "pattern:aws_access_key_id",
    re: /AKIA[0-9A-Z]{16}/,
  },
  {
    source: "pattern:slack_token",
    re: /xox[bpars]-[A-Za-z0-9-]{10,}/,
  },
  {
    source: "pattern:jwt",
    re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  },
  {
    // Span the WHOLE block (BEGIN through END), not just the header — the
    // secret is the base64 body. Non-greedy so multiple keys don't coalesce;
    // falls back to end-of-input if the END marker is missing (truncated key),
    // erring toward over-redaction rather than leaking a partial key body.
    source: "pattern:pem_private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/,
  },
  {
    // Matches ONLY the user:pass userinfo inside a URL with embedded creds.
    // Lookbehind anchors to :// so scheme is not consumed; lookahead anchors
    // to @ so host is not consumed. Char classes require at least one char in
    // each of user and pass (no empty user or empty pass).
    source: "pattern:conn_string_userinfo",
    re: /(?<=:\/\/)[^:@/\s]+:[^@/\s]+(?=@)/,
  },
];
