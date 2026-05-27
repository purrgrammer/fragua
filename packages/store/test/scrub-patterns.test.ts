// Tests for BASE_PATTERNS — the base credential-pattern set for the scrubber.
// Each pattern is exercised via compileRegistry + scrubText to assert:
//   (a) the sample secret is redacted with the correct [REDACTED:source] marker
//   (b) benign text surrounding the secret is preserved

import { describe, expect, test } from "bun:test";
import { BASE_PATTERNS, compileRegistry, scrubText } from "../src/index.ts";

function regFor(source: string) {
  const pattern = BASE_PATTERNS.find((p) => p.source === source);
  if (!pattern) throw new Error(`Pattern not found: ${source}`);
  return compileRegistry({ literals: [], patterns: [pattern] });
}

// ---------------------------------------------------------------------------
// pattern:anthropic_key
// ---------------------------------------------------------------------------

describe("pattern:anthropic_key", () => {
  test("redacts an Anthropic API key", () => {
    const r = regFor("pattern:anthropic_key");
    const result = scrubText("Authorization: Bearer sk-ant-api03-ABCDEFGHIJ1234567890abcde", r);
    expect(result).toBe("Authorization: Bearer [REDACTED:pattern:anthropic_key]");
  });

  test("preserves surrounding benign text", () => {
    const r = regFor("pattern:anthropic_key");
    const result = scrubText("key=sk-ant-xxxxxxxxxxxxxxxxxxx1234567 end", r);
    expect(result).toContain("[REDACTED:pattern:anthropic_key]");
    expect(result).toStartWith("key=");
    expect(result).toEndWith(" end");
  });
});

// ---------------------------------------------------------------------------
// pattern:openai_key
// ---------------------------------------------------------------------------

describe("pattern:openai_key", () => {
  test("redacts a bare sk- key", () => {
    const r = regFor("pattern:openai_key");
    const result = scrubText("token sk-abcdefghijklmnopqrstu1234567890 here", r);
    expect(result).toBe("token [REDACTED:pattern:openai_key] here");
  });

  test("redacts a sk-proj- key", () => {
    const r = regFor("pattern:openai_key");
    const result = scrubText("key=sk-proj-ABCDEFGHIJKLMNOPQRST1234567890ab done", r);
    expect(result).toBe("key=[REDACTED:pattern:openai_key] done");
  });

  test("preserves prefix and suffix", () => {
    const r = regFor("pattern:openai_key");
    const result = scrubText("prefix sk-ABCDEFGHIJKLMNOPQRSTUabcdefghij suffix", r);
    expect(result).toContain("[REDACTED:pattern:openai_key]");
    expect(result).toContain("prefix ");
    expect(result).toContain(" suffix");
  });

  test("does NOT match sk-ant- (Anthropic key — caught by anthropic_key pattern instead)", () => {
    const r = regFor("pattern:openai_key");
    const antKey = "sk-ant-api03-ABCDEFGHIJ1234567890abcde";
    const result = scrubText(antKey, r);
    expect(result).toBe(antKey);
  });

  test("sk-proj- key is still matched by openai_key", () => {
    const r = regFor("pattern:openai_key");
    const result = scrubText("key=sk-proj-ABCDEFGHIJKLMNOPQRST1234567890ab", r);
    expect(result).toContain("[REDACTED:pattern:openai_key]");
  });

  test("plain sk- key (non-ant) is still matched by openai_key", () => {
    const r = regFor("pattern:openai_key");
    const result = scrubText("key=sk-ABCDEFGHIJKLMNOPQRSTUabcdefghij", r);
    expect(result).toContain("[REDACTED:pattern:openai_key]");
  });

  test("anthropic_key pattern catches sk-ant- with the correct label", () => {
    const r = regFor("pattern:anthropic_key");
    const result = scrubText("sk-ant-api03-ABCDEFGHIJ1234567890abcde", r);
    expect(result).toBe("[REDACTED:pattern:anthropic_key]");
  });
});

// ---------------------------------------------------------------------------
// pattern:github_token
// ---------------------------------------------------------------------------

describe("pattern:github_token", () => {
  const samples: [string, string][] = [
    ["ghp_", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"],
    ["gho_", "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"],
    ["ghs_", "ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"],
    ["ghu_", "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"],
  ];

  for (const [prefix, token] of samples) {
    test(`redacts ${prefix} token`, () => {
      const r = regFor("pattern:github_token");
      const result = scrubText(`token: ${token} end`, r);
      expect(result).toBe("token: [REDACTED:pattern:github_token] end");
    });
  }

  test("preserves surrounding text", () => {
    const r = regFor("pattern:github_token");
    const result = scrubText("GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rest", r);
    expect(result).toContain("GITHUB_TOKEN=");
    expect(result).toContain("[REDACTED:pattern:github_token]");
    expect(result).toContain(" rest");
  });
});

// ---------------------------------------------------------------------------
// pattern:aws_access_key_id
// ---------------------------------------------------------------------------

describe("pattern:aws_access_key_id", () => {
  test("redacts an AWS access key ID", () => {
    const r = regFor("pattern:aws_access_key_id");
    const result = scrubText("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE here", r);
    expect(result).toBe("AWS_ACCESS_KEY_ID=[REDACTED:pattern:aws_access_key_id] here");
  });

  test("preserves surrounding text", () => {
    const r = regFor("pattern:aws_access_key_id");
    const result = scrubText("key: AKIAIOSFODNN7EXAMPLE.", r);
    expect(result).toContain("[REDACTED:pattern:aws_access_key_id]");
    expect(result).toStartWith("key: ");
  });
});

// ---------------------------------------------------------------------------
// pattern:slack_token
// ---------------------------------------------------------------------------

describe("pattern:slack_token", () => {
  const prefixes = ["xoxb", "xoxp", "xoxa", "xoxr", "xoxs"];

  for (const prefix of prefixes) {
    test(`redacts ${prefix}- token`, () => {
      const r = regFor("pattern:slack_token");
      const token = `${prefix}-1234567890-abcdefghij`;
      const result = scrubText(`slack token: ${token} end`, r);
      expect(result).toBe("slack token: [REDACTED:pattern:slack_token] end");
    });
  }

  test("preserves surrounding text", () => {
    const r = regFor("pattern:slack_token");
    const result = scrubText("SLACK_TOKEN=xoxb-1234567890-abcdefghij done", r);
    expect(result).toContain("SLACK_TOKEN=");
    expect(result).toContain("[REDACTED:pattern:slack_token]");
    expect(result).toContain(" done");
  });

  test("(bug-1) adversarial dashed input does not over-consume trailing natural text", () => {
    const r = regFor("pattern:slack_token");
    // Many dash-separated segments followed by normal English text that must NOT be swallowed.
    const adversarial = "xoxb-1-a-b-c-d-e-f-g-h-i-j-k-natural-text-is-here word2 word3";
    const result = scrubText(adversarial, r);
    // The redacted span must be short — natural text after the token should survive.
    const markerIdx = result.indexOf("[REDACTED:pattern:slack_token]");
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    // Everything after the marker must contain the trailing natural text.
    const afterMarker = result.slice(markerIdx + "[REDACTED:pattern:slack_token]".length);
    expect(afterMarker).toContain("natural-text-is-here");
  });
});

// ---------------------------------------------------------------------------
// pattern:jwt
// ---------------------------------------------------------------------------

describe("pattern:jwt", () => {
  // A realistic (but synthetic) JWT with three base64url segments.
  const sampleJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  test("redacts a JWT token", () => {
    const r = regFor("pattern:jwt");
    const result = scrubText(`Bearer ${sampleJwt} end`, r);
    expect(result).toBe("Bearer [REDACTED:pattern:jwt] end");
  });

  test("preserves surrounding text", () => {
    const r = regFor("pattern:jwt");
    const result = scrubText(`Authorization: Bearer ${sampleJwt}.`, r);
    expect(result).toContain("Authorization: Bearer ");
    expect(result).toContain("[REDACTED:pattern:jwt]");
  });
});

// ---------------------------------------------------------------------------
// pattern:pem_private_key
// ---------------------------------------------------------------------------

describe("pattern:pem_private_key", () => {
  test("redacts the ENTIRE RSA PRIVATE KEY block — body included, not just the header", () => {
    const r = regFor("pattern:pem_private_key");
    const body = "MIIEpAIBAAKCAQEAsecretkeymaterial0123456789abcdef";
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const result = scrubText(`cert:\n${pem}`, r);
    expect(result).toBe("cert:\n[REDACTED:pattern:pem_private_key]");
    // The key body must NOT survive (the header-only regex bug left it behind).
    expect(result).not.toContain(body);
    expect(result).not.toContain("MIIE");
  });

  test("redacts the whole EC PRIVATE KEY block", () => {
    const r = regFor("pattern:pem_private_key");
    const result = scrubText("-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEsecretEC\n-----END EC PRIVATE KEY-----", r);
    expect(result).toBe("[REDACTED:pattern:pem_private_key]");
    expect(result).not.toContain("MHcCAQEEsecretEC");
  });

  test("a truncated key (BEGIN, no END) still redacts the partial body to end-of-input", () => {
    const r = regFor("pattern:pem_private_key");
    const result = scrubText("key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADApartialbody", r);
    expect(result).toBe("key: [REDACTED:pattern:pem_private_key]");
    expect(result).not.toContain("MIIEvQIBADA");
  });
});

// ---------------------------------------------------------------------------
// pattern:conn_string_userinfo
// ---------------------------------------------------------------------------

describe("pattern:conn_string_userinfo", () => {
  test("redacts only user:pass, keeping scheme and host", () => {
    const r = regFor("pattern:conn_string_userinfo");
    const result = scrubText("postgres://alice:s3cretpw@db.example.com:5432/app", r);
    expect(result).toContain("postgres://");
    expect(result).toContain("@db.example.com");
    expect(result).toContain("[REDACTED:pattern:conn_string_userinfo]");
    expect(result).not.toContain("alice");
    expect(result).not.toContain("s3cretpw");
    expect(result).toBe("postgres://[REDACTED:pattern:conn_string_userinfo]@db.example.com:5432/app");
  });

  test("redacts redis connection string userinfo", () => {
    const r = regFor("pattern:conn_string_userinfo");
    const result = scrubText("redis://user:password123@redis.example.com:6379/0", r);
    expect(result).toBe("redis://[REDACTED:pattern:conn_string_userinfo]@redis.example.com:6379/0");
    expect(result).toContain("redis://");
    expect(result).toContain("@redis.example.com");
  });

  test("redacts amqp connection string userinfo", () => {
    const r = regFor("pattern:conn_string_userinfo");
    const result = scrubText("amqp://guest:guestpw@rabbitmq.internal:5672/vhost", r);
    expect(result).toContain("amqp://");
    expect(result).toContain("@rabbitmq.internal");
    expect(result).not.toContain("guest:guestpw");
  });

  test("preserves URLs without embedded credentials", () => {
    const r = regFor("pattern:conn_string_userinfo");
    const plain = "https://api.example.com/v1/data";
    expect(scrubText(plain, r)).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// No-op: plain sentence with no secrets
// ---------------------------------------------------------------------------

describe("BASE_PATTERNS no-op", () => {
  test("plain text with no secrets is returned unchanged", () => {
    const r = compileRegistry({ literals: [], patterns: [...BASE_PATTERNS] });
    const text = "The quick brown fox jumps over the lazy dog. Count: 42. Status: OK.";
    expect(scrubText(text, r)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Bounded tails — a key embedded in a long alphanumeric run must not greedily
// consume past its realistic length (CSV row / slug / dense token).
// ---------------------------------------------------------------------------

describe("pattern length bounds", () => {
  test("openai_key does not consume an unbounded alnum tail (capped at 200)", () => {
    const r = regFor("pattern:openai_key");
    const result = scrubText(`sk-${"x".repeat(400)}`, r);
    expect(result).toContain("[REDACTED:pattern:openai_key]");
    // The tail beyond the cap survives — pre-bound this would be one big redaction.
    expect(result).toMatch(/x{50,}/);
  });

  test("github_token does not consume an unbounded alnum tail", () => {
    const r = regFor("pattern:github_token");
    const result = scrubText(`ghp_${"a".repeat(400)}`, r);
    expect(result).toContain("[REDACTED:pattern:github_token]");
    expect(result).toMatch(/a{50,}/);
  });
});
