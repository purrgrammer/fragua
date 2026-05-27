// Secret-scrubbing core tests.
// Covers: exact literal hit; base64/base64url/percent encodings; value-length
// floor; pattern hit; overlap merge; adjacent merge; generic vs source labels;
// determinism; no-length-preservation; property test (seeded needle → absent).

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { pbtRuns } from "../../../test/pbt-runs.ts";
import {
  buildExportRegistry,
  compileRegistry,
  isBlobRef,
  makeBlobRef,
  scrubJsonStrings,
  scrubText,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reg(literals: Array<{ value: string; source: string }>, patterns: Array<{ source: string; re: RegExp }> = []) {
  return compileRegistry({ literals, patterns });
}

// Encoding helpers (mirrors the implementation — used in tests to generate
// the encoded forms to embed in text).
function b64(s: string) {
  return Buffer.from(s, "utf8").toString("base64");
}
function b64url(s: string) {
  return Buffer.from(s, "utf8").toString("base64url");
}
function pct(s: string) {
  return encodeURIComponent(s);
}

// ---------------------------------------------------------------------------
// Exact literal hit
// ---------------------------------------------------------------------------

describe("exact literal hit", () => {
  test("replaces the verbatim needle with a [REDACTED:source] marker", () => {
    const r = reg([{ value: "supersecret1234", source: "provider_creds" }]);
    expect(scrubText("prefix supersecret1234 suffix", r)).toBe("prefix [REDACTED:provider_creds] suffix");
  });

  test("needle at start of string", () => {
    const r = reg([{ value: "supersecret1234", source: "env:MY_KEY" }]);
    expect(scrubText("supersecret1234 trailing", r)).toBe("[REDACTED:env:MY_KEY] trailing");
  });

  test("needle at end of string", () => {
    const r = reg([{ value: "supersecret1234", source: "env:MY_KEY" }]);
    expect(scrubText("leading supersecret1234", r)).toBe("leading [REDACTED:env:MY_KEY]");
  });

  test("needle occupies entire string", () => {
    const r = reg([{ value: "supersecret1234", source: "provider_creds" }]);
    expect(scrubText("supersecret1234", r)).toBe("[REDACTED:provider_creds]");
  });

  test("no-op when no needle in text", () => {
    const r = reg([{ value: "supersecret1234", source: "provider_creds" }]);
    expect(scrubText("nothing to redact here", r)).toBe("nothing to redact here");
  });
});

// ---------------------------------------------------------------------------
// Encoding expansion — each declared encoding of a literal is caught
// ---------------------------------------------------------------------------

const SECRET = "my-api-key-xyzzy9"; // >= 8 chars, no whitespace

describe("encoding expansion", () => {
  const r = reg([{ value: SECRET, source: "env:API_KEY" }]);

  test("verbatim form is caught", () => {
    expect(scrubText(`before ${SECRET} after`, r)).not.toContain(SECRET);
  });

  test("base64 form is caught", () => {
    const encoded = b64(SECRET);
    expect(scrubText(`data: ${encoded}`, r)).not.toContain(encoded);
    expect(scrubText(`data: ${encoded}`, r)).toContain("[REDACTED");
  });

  test("base64url form is caught", () => {
    const encoded = b64url(SECRET);
    expect(scrubText(`data: ${encoded}`, r)).not.toContain(encoded);
    expect(scrubText(`data: ${encoded}`, r)).toContain("[REDACTED");
  });

  test("percent-encoded form is caught", () => {
    const encoded = pct(SECRET);
    expect(scrubText(`url: https://example.com/path?key=${encoded}`, r)).not.toContain(encoded);
    expect(scrubText(`url: https://example.com/path?key=${encoded}`, r)).toContain("[REDACTED");
  });
});

// ---------------------------------------------------------------------------
// Value-length floor
// ---------------------------------------------------------------------------

describe("value-length floor", () => {
  test("4-char needle is dropped — not redacted", () => {
    const r = reg([{ value: "abcd", source: "env:SHORT" }]);
    expect(scrubText("prefix abcd suffix", r)).toBe("prefix abcd suffix");
  });

  test("7-char needle is dropped — not redacted", () => {
    const r = reg([{ value: "1234567", source: "env:SEVEN" }]);
    expect(scrubText("prefix 1234567 suffix", r)).toBe("prefix 1234567 suffix");
  });

  test("8-char needle is accepted — is redacted", () => {
    const r = reg([{ value: "12345678", source: "env:EIGHT" }]);
    expect(scrubText("prefix 12345678 suffix", r)).not.toContain("12345678");
  });

  test("needle with whitespace is dropped", () => {
    const r = reg([{ value: "hello world!!", source: "env:SPACES" }]);
    expect(scrubText("hello world!!", r)).toBe("hello world!!");
  });

  test("needle with tab is dropped", () => {
    const r = reg([{ value: "hello\tworld!!", source: "env:TAB" }]);
    expect(scrubText("hello\tworld!!", r)).toBe("hello\tworld!!");
  });
});

// ---------------------------------------------------------------------------
// Pattern hit
// ---------------------------------------------------------------------------

const AWS_KEY_PATTERN = { source: "pattern:aws_key", re: /AKIA[0-9A-Z]{16}/ };
const JWT_PATTERN = {
  source: "pattern:jwt",
  re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_\-+/=]+/,
};

describe("pattern hit", () => {
  test("AWS key pattern is caught", () => {
    const r = reg([], [AWS_KEY_PATTERN]);
    const text = "key=AKIAIOSFODNN7EXAMPLE";
    const result = scrubText(text, r);
    expect(result).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result).toContain("[REDACTED:pattern:aws_key]");
  });

  test("JWT-ish pattern is caught", () => {
    const r = reg([], [JWT_PATTERN]);
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = scrubText(`token: ${jwt}`, r);
    expect(result).not.toContain(jwt);
    expect(result).toContain("[REDACTED:pattern:jwt]");
  });

  test("pattern does not affect non-matching text", () => {
    const r = reg([], [AWS_KEY_PATTERN]);
    expect(scrubText("hello world", r)).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// Overlapping literal + pattern → single marker with most-specific source
// ---------------------------------------------------------------------------

describe("overlap merge", () => {
  test("literal inside pattern → single [REDACTED] with provider_creds precedence", () => {
    // The literal value happens to look like an AWS key and matches both.
    const literal = "AKIAIOSFODNN7EXAMPLE";
    const r = reg([{ value: literal, source: "provider_creds" }], [AWS_KEY_PATTERN]);
    const text = `key=${literal}`;
    const result = scrubText(text, r);
    // Only ONE marker.
    expect((result.match(/\[REDACTED/g) ?? []).length).toBe(1);
    // provider_creds wins over pattern:*.
    expect(result).toContain("[REDACTED:provider_creds]");
  });

  test("env:* beats pattern:*", () => {
    const literal = "AKIAIOSFODNN7EXAMPLE";
    const r = reg([{ value: literal, source: "env:AWS_KEY" }], [AWS_KEY_PATTERN]);
    const result = scrubText(literal, r);
    expect((result.match(/\[REDACTED/g) ?? []).length).toBe(1);
    expect(result).toContain("[REDACTED:env:AWS_KEY]");
  });

  test("provider_creds beats env:* (provider_creds first)", () => {
    const literal = "AKIAIOSFODNN7EXAMPLE";
    const r = reg(
      [
        { value: literal, source: "provider_creds" },
        { value: literal, source: "env:AWS_KEY" },
      ],
      [],
    );
    const result = scrubText(literal, r);
    expect((result.match(/\[REDACTED/g) ?? []).length).toBe(1);
    expect(result).toContain("[REDACTED:provider_creds]");
  });

  test("provider_creds beats env:* (env first — precedence wins over insertion order)", () => {
    const literal = "AKIAIOSFODNN7EXAMPLE";
    const r = reg(
      [
        { value: literal, source: "env:AWS_KEY" },
        { value: literal, source: "provider_creds" },
      ],
      [],
    );
    const result = scrubText(literal, r);
    expect((result.match(/\[REDACTED/g) ?? []).length).toBe(1);
    expect(result).toContain("[REDACTED:provider_creds]");
  });
});

// ---------------------------------------------------------------------------
// Adjacent spans merge
// ---------------------------------------------------------------------------

describe("adjacent spans merge", () => {
  test("two immediately-adjacent needles → single marker", () => {
    const r = reg([
      { value: "secretone1", source: "env:A" },
      { value: "secrettwo2", source: "env:B" },
    ]);
    // Place them back-to-back — spans are adjacent.
    const text = "secretone1secrettwo2";
    const result = scrubText(text, r);
    // Only one [REDACTED marker.
    expect((result.match(/\[REDACTED/g) ?? []).length).toBe(1);
  });

  test("two separated needles → two markers", () => {
    const r = reg([
      { value: "secretone1", source: "env:A" },
      { value: "secrettwo2", source: "env:B" },
    ]);
    const result = scrubText("secretone1 secrettwo2", r);
    // A space separates them — two distinct markers.
    expect((result.match(/\[REDACTED/g) ?? []).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Label modes
// ---------------------------------------------------------------------------

describe("label modes", () => {
  const r = reg([{ value: "mysecretvalue", source: "provider_creds" }]);

  test("default (source) mode emits [REDACTED:<source>]", () => {
    expect(scrubText("mysecretvalue", r)).toBe("[REDACTED:provider_creds]");
  });

  test("explicit source mode emits [REDACTED:<source>]", () => {
    expect(scrubText("mysecretvalue", r, { labels: "source" })).toBe("[REDACTED:provider_creds]");
  });

  test("generic mode emits [REDACTED]", () => {
    expect(scrubText("mysecretvalue", r, { labels: "generic" })).toBe("[REDACTED]");
  });

  test("generic mode with pattern", () => {
    const pr = reg([], [AWS_KEY_PATTERN]);
    const result = scrubText("key=AKIAIOSFODNN7EXAMPLE", pr, { labels: "generic" });
    expect(result).not.toContain("AKIA");
    expect(result).toBe("key=[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  test("same input + registry → identical output across two calls", () => {
    const r = reg(
      [
        { value: "mysecretvalue", source: "provider_creds" },
        { value: "anotherkey9999", source: "env:KEY2" },
      ],
      [AWS_KEY_PATTERN],
    );
    const text = "prefix mysecretvalue middle AKIAIOSFODNN7EXAMPLE anotherkey9999 suffix";
    const r1 = scrubText(text, r);
    const r2 = scrubText(text, r);
    expect(r1).toBe(r2);
  });

  test("two separately compiled registries with same inputs → same output", () => {
    const literals = [
      { value: "mysecretvalue", source: "provider_creds" },
      { value: "anotherkey9999", source: "env:KEY2" },
    ];
    const patterns = [AWS_KEY_PATTERN];
    const r1 = compileRegistry({ literals, patterns });
    const r2 = compileRegistry({ literals, patterns });
    const text = "mysecretvalue and anotherkey9999 and AKIAIOSFODNN7EXAMPLE";
    expect(scrubText(text, r1)).toBe(scrubText(text, r2));
  });
});

// ---------------------------------------------------------------------------
// No length preservation
// ---------------------------------------------------------------------------

describe("no length preservation", () => {
  test("long secret and short secret produce identical markers (same source)", () => {
    const longSecret = "a-very-long-api-key-that-is-quite-long-indeed-xyz";
    const shortSecret = "short-sec";
    const rLong = reg([{ value: longSecret, source: "provider_creds" }]);
    const rShort = reg([{ value: shortSecret, source: "provider_creds" }]);
    const long = scrubText(longSecret, rLong);
    const short = scrubText(shortSecret, rShort);
    // Both collapse to the same marker — length not preserved.
    expect(long).toBe("[REDACTED:provider_creds]");
    expect(short).toBe("[REDACTED:provider_creds]");
    expect(long).toBe(short);
  });

  test("marker length differs from original secret length", () => {
    const secret = "my-api-secret-12345";
    const r = reg([{ value: secret, source: "env:API" }]);
    const result = scrubText(secret, r);
    expect(result.length).not.toBe(secret.length);
  });
});

// ---------------------------------------------------------------------------
// Property test: seeded needle in any declared encoding → absent after scrub
// ---------------------------------------------------------------------------

describe("PBT — seeded needle absent in all declared encodings", () => {
  test("any 8+ char no-whitespace literal is absent (verbatim) after scrub", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a valid needle: ≥8 chars, no whitespace.
        fc
          .string({ minLength: 8, maxLength: 40 })
          .filter((s) => !/\s/.test(s)),
        // Random surrounding text.
        fc.string({ minLength: 0, maxLength: 60 }),
        fc.string({ minLength: 0, maxLength: 60 }),
        async (needle, prefix, suffix) => {
          const r = compileRegistry({
            literals: [{ value: needle, source: "env:TEST" }],
            patterns: [],
          });
          const verbatim = scrubText(`${prefix}${needle}${suffix}`, r);
          expect(verbatim).not.toContain(needle);
        },
      ),
      { numRuns: pbtRuns(200) },
    );
  });

  test("base64 encoding of a seeded needle is absent after scrub", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 40 }).filter((s) => !/\s/.test(s)),
        fc.string({ minLength: 0, maxLength: 40 }),
        fc.string({ minLength: 0, maxLength: 40 }),
        async (needle, prefix, suffix) => {
          const r = compileRegistry({
            literals: [{ value: needle, source: "env:TEST" }],
            patterns: [],
          });
          const encoded = b64(needle);
          const result = scrubText(`${prefix}${encoded}${suffix}`, r);
          expect(result).not.toContain(encoded);
        },
      ),
      { numRuns: pbtRuns(100) },
    );
  });

  test("base64url encoding of a seeded needle is absent after scrub", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 40 }).filter((s) => !/\s/.test(s)),
        fc.string({ minLength: 0, maxLength: 40 }),
        fc.string({ minLength: 0, maxLength: 40 }),
        async (needle, prefix, suffix) => {
          const r = compileRegistry({
            literals: [{ value: needle, source: "env:TEST" }],
            patterns: [],
          });
          const encoded = b64url(needle);
          const result = scrubText(`${prefix}${encoded}${suffix}`, r);
          expect(result).not.toContain(encoded);
        },
      ),
      { numRuns: pbtRuns(100) },
    );
  });

  test("percent-encoded form of a seeded needle is absent after scrub", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 8, maxLength: 40 }).filter((s) => !/\s/.test(s)),
        fc.string({ minLength: 0, maxLength: 40 }),
        fc.string({ minLength: 0, maxLength: 40 }),
        async (needle, prefix, suffix) => {
          const r = compileRegistry({
            literals: [{ value: needle, source: "env:TEST" }],
            patterns: [],
          });
          const encoded = pct(needle);
          const result = scrubText(`${prefix}${encoded}${suffix}`, r);
          expect(result).not.toContain(encoded);
        },
      ),
      { numRuns: pbtRuns(100) },
    );
  });
});

// ---------------------------------------------------------------------------
// Large registry — guards against a dense per-state goto representation.
// A sparse automaton compiles ~50 needles (×4 encodings = ~200 needle strings)
// instantly; a dense Int32Array(65536)-per-state build would allocate hundreds
// of MB and loop ~1e8× here. This asserts correctness at that scale.
// ---------------------------------------------------------------------------

describe("large registry (sparse representation)", () => {
  test("compiles ~50 distinct needles and redacts every one", () => {
    const literals = Array.from({ length: 50 }, (_, i) => ({
      value: `secret-value-number-${i}-padding`,
      source: `env:KEY_${i}`,
    }));
    const r = reg(literals);

    const text = literals.map((l) => `field=${l.value};`).join(" ");
    const result = scrubText(text, r);

    for (const l of literals) {
      expect(result).not.toContain(l.value);
    }
    expect((result.match(/\[REDACTED/g) ?? []).length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Bug-2: scrubJsonStrings must not recurse into BlobRef objects
// ---------------------------------------------------------------------------

describe("(bug-2) scrubJsonStrings leaves BlobRef sha untouched", () => {
  test("a BlobRef whose sha is also a literal needle is returned unchanged", () => {
    const sha = "abcdef1234567890".repeat(4); // valid 64-hex sha
    const { registry } = buildExportRegistry({
      providerCredentials: [],
      cwd: null,
      extraLiterals: [{ value: sha, source: "env:SHA_NEEDLE" }],
    });
    const ref = makeBlobRef(sha, 100);
    const result = scrubJsonStrings(ref, registry) as typeof ref;
    // Bug: currently the sha inside the BlobRef is redacted.
    // Fix: isBlobRef short-circuit should return the object unchanged.
    expect(isBlobRef(result)).toBe(true);
    expect((result as unknown as Record<string, unknown>)["$fragua_blob"]).toBe(sha);
  });
});

// ---------------------------------------------------------------------------
// Bug-5: zero-width regex match must not emit a spurious [REDACTED]
// ---------------------------------------------------------------------------

describe("(bug-5) zero-width pattern match produces no spurious REDACTED", () => {
  test("a pattern that can match zero-width does not redact clean text", () => {
    const zeroWidthPattern = { source: "pattern:zero", re: /a*/ };
    const registry = compileRegistry({ literals: [], patterns: [zeroWidthPattern] });
    // 'hello' contains no 'a', so every position zero-width matches /a*/ = empty string.
    // Bug: current code pushes a 0-length span before the guard, emitting [REDACTED] at every char.
    const result = scrubText("hello", registry);
    expect(result).toBe("hello");
  });
});
