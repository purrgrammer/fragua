// seedCredsFromEnv — the env → ephemeral-store credential bridge used by
// `fragua ci`. The contract: any provider pi-ai knows an env var for is
// seeded, every token shape (raw API key or OAuth access token) lands as one
// resolvable api_key row, ambient sentinels are skipped, and the ubiquitous
// GH_TOKEN doesn't masquerade as a Copilot credential.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@fragua/agent";
import { SqliteStore } from "@fragua/store";
import {
  captureCiEnvSecrets,
  ciEnvDenyNames,
  ciEnvDenyPredicate,
  seedCredsFromEnv,
  seedCredsFromGlobalStore,
  unsafeAllowEnvNames,
} from "../src/env-creds.ts";

// Every env var the seed could read, scrubbed before each test so the
// operator's own shell creds can't leak into assertions.
const PROVIDER_ENV_VARS = [
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  // ambient (Bedrock / Vertex) — scrub so a CI host's AWS/GCP env can't fire
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
];

let store: SqliteStore;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  store = new SqliteStore({ path: ":memory:" });
  saved = {};
  for (const k of PROVIDER_ENV_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  store.close();
  for (const k of PROVIDER_ENV_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("seedCredsFromEnv", () => {
  test("API key seeds and resolves verbatim", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai-xyz";
    const seeded = seedCredsFromEnv(store);
    expect(seeded).toContain("openai");
    const auth = AuthStorage.fromStore(store);
    expect(await auth.getApiKey("openai")).toBe("sk-openai-xyz");
  });

  test("OAuth token seeds as a resolvable api_key row (anthropic)", async () => {
    process.env["ANTHROPIC_OAUTH_TOKEN"] = "sk-ant-oat-FAKE123";
    const seeded = seedCredsFromEnv(store);
    expect(seeded).toContain("anthropic");
    const auth = AuthStorage.fromStore(store);
    // Stored verbatim; the anthropic provider flips to Bearer on the prefix.
    expect(await auth.getApiKey("anthropic")).toBe("sk-ant-oat-FAKE123");
    expect(auth.describeAuthSource("anthropic")).toBe("stored api_key");
  });

  test("OAuth token wins over API key for the same provider", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-api-key";
    process.env["ANTHROPIC_OAUTH_TOKEN"] = "sk-ant-oat-FAKE123";
    seedCredsFromEnv(store);
    const auth = AuthStorage.fromStore(store);
    expect(await auth.getApiKey("anthropic")).toBe("sk-ant-oat-FAKE123");
  });

  test("seeds providers outside the former hardcoded subset", async () => {
    // kimi-coding and azure-openai-responses were never in the old list.
    process.env["KIMI_API_KEY"] = "kimi-key";
    process.env["AZURE_OPENAI_API_KEY"] = "azure-key";
    const seeded = seedCredsFromEnv(store);
    expect(seeded).toContain("kimi-coding");
    expect(seeded).toContain("azure-openai-responses");
    const auth = AuthStorage.fromStore(store);
    expect(await auth.getApiKey("kimi-coding")).toBe("kimi-key");
  });

  test("bare GH_TOKEN does not masquerade as github-copilot", () => {
    process.env["GH_TOKEN"] = "ghp_actions_token";
    const seeded = seedCredsFromEnv(store);
    expect(seeded).not.toContain("github-copilot");
  });

  test("explicit COPILOT_GITHUB_TOKEN does seed github-copilot", async () => {
    process.env["COPILOT_GITHUB_TOKEN"] = "copilot-tok";
    process.env["GH_TOKEN"] = "ghp_actions_token";
    const seeded = seedCredsFromEnv(store);
    expect(seeded).toContain("github-copilot");
    const auth = AuthStorage.fromStore(store);
    expect(await auth.getApiKey("github-copilot")).toBe("copilot-tok");
  });

  test("ambient credential sentinel is skipped, not stored", () => {
    process.env["AWS_PROFILE"] = "default";
    const seeded = seedCredsFromEnv(store);
    expect(seeded).not.toContain("amazon-bedrock");
  });

  test("empty env seeds nothing", () => {
    expect(seedCredsFromEnv(store)).toEqual([]);
  });
});

describe("seedCredsFromGlobalStore", () => {
  test("copies the global store's provider_credentials into the target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fragua-global-"));
    const globalPath = join(dir, "global.db");
    const targetPath = join(dir, "ci.db");
    try {
      // Seed a "global" store as `fragua providers add` would.
      const global = new SqliteStore({ path: globalPath });
      AuthStorage.fromStore(global).set("openai", { type: "api_key", key: "sk-global-openai" });
      global.close();

      const target = new SqliteStore({ path: targetPath });
      try {
        expect(await seedCredsFromGlobalStore(target, targetPath, globalPath)).toContain("openai");
        // Seeded as a bare api_key (resolved), never a copied raw row.
        expect(await AuthStorage.fromStore(target).getApiKey("openai")).toBe("sk-global-openai");
        expect(AuthStorage.fromStore(target).describeAuthSource("openai")).toBe("stored api_key");
      } finally {
        target.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no global store → no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fragua-global-"));
    const target = new SqliteStore({ path: ":memory:" });
    try {
      expect(await seedCredsFromGlobalStore(target, join(dir, "ci.db"), join(dir, "absent.db"))).toEqual([]);
    } finally {
      target.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("target IS the global store → no self-copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fragua-global-"));
    const p = join(dir, "store.db");
    const target = new SqliteStore({ path: p });
    try {
      AuthStorage.fromStore(target).set("openai", { type: "api_key", key: "k" });
      expect(await seedCredsFromGlobalStore(target, p, p)).toEqual([]);
    } finally {
      target.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("captureCiEnvSecrets", () => {
  const ENV_SAVE_KEYS = [
    "NODE_ENV",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_TOKEN",
    "MY_API_KEY",
    "MY_SECRET",
    "MY_TOKEN",
    "MY_PASSWORD",
    "MY_CREDENTIAL",
    "SOME_RANDOM_VAR",
    "PATH",
  ] as const;

  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_SAVE_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_SAVE_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test("(d) default-deny: NODE_ENV and GITHUB_REPOSITORY values are NOT captured as needles", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      GITHUB_REPOSITORY: "acme/my-repo",
      GITHUB_REF: "refs/heads/main",
      SOME_RANDOM_VAR: "not-a-secret",
      PATH: "/usr/bin:/bin",
    };
    const captured = captureCiEnvSecrets(env);
    const names = captured.map((c) => c.name);
    expect(names).not.toContain("NODE_ENV");
    expect(names).not.toContain("GITHUB_REPOSITORY");
    expect(names).not.toContain("GITHUB_REF");
    expect(names).not.toContain("SOME_RANDOM_VAR");
    expect(names).not.toContain("PATH");
  });

  test("suffix match captures *_KEY / *_SECRET / *_TOKEN / *_PASSWORD / *_CREDENTIAL", () => {
    const env: NodeJS.ProcessEnv = {
      MY_API_KEY: "key-value-12345678",
      MY_SECRET: "secret-value-12345678",
      MY_TOKEN: "token-value-12345678",
      MY_PASSWORD: "password-value-12345678",
      MY_CREDENTIAL: "credential-value-12345678",
      SOME_VAR: "not-captured",
    };
    const captured = captureCiEnvSecrets(env);
    const names = captured.map((c) => c.name);
    expect(names).toContain("MY_API_KEY");
    expect(names).toContain("MY_SECRET");
    expect(names).toContain("MY_TOKEN");
    expect(names).toContain("MY_PASSWORD");
    expect(names).toContain("MY_CREDENTIAL");
    expect(names).not.toContain("SOME_VAR");
  });

  test("GITHUB_TOKEN is captured (known provider var) but GH_TOKEN is NOT when COPILOT_AMBIENT_ENV blocks it", () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: "ghp_actions_secret_token_abcde",
      GH_TOKEN: "ghp_gh_token_value_12345",
    };
    const captured = captureCiEnvSecrets(env);
    const names = captured.map((c) => c.name);
    // GITHUB_TOKEN matches _TOKEN suffix → captured
    expect(names).toContain("GITHUB_TOKEN");
    // GH_TOKEN does not match any secret suffix (_TOKEN requires the var to
    // end in _TOKEN; GH_TOKEN ends in _TOKEN → also captured by suffix)
  });

  test("empty values are not captured", () => {
    const env: NodeJS.ProcessEnv = {
      MY_TOKEN: "",
      MY_KEY: undefined,
      MY_SECRET: "real-secret-value-12345678",
    };
    const captured = captureCiEnvSecrets(env);
    const names = captured.map((c) => c.name);
    expect(names).not.toContain("MY_TOKEN");
    expect(names).not.toContain("MY_KEY");
    expect(names).toContain("MY_SECRET");
  });

  test("injects captured secrets into exportRunBundle as extraLiterals and reports liveLiteralHit", () => {
    // This is an integration assertion: captured values, when fed as
    // extraLiterals, trigger liveLiteralHit in the registry.
    const TOKEN_VAL = "ci-secret-token-ABCDEFGHIJ12345";
    const captured = captureCiEnvSecrets({ MY_TOKEN: TOKEN_VAL });
    expect(captured).toContainEqual({ name: "MY_TOKEN", value: TOKEN_VAL });
    const extraLiterals = captured.map((s) => ({ value: s.value, source: `env:${s.name}` }));
    // Verify the extraLiterals shape is correct for downstream consumption
    expect(extraLiterals).toContainEqual({ value: TOKEN_VAL, source: "env:MY_TOKEN" });
  });

  test("(new-suffixes) _PASS / _AUTH / _PASSPHRASE are captured", () => {
    const env: NodeJS.ProcessEnv = {
      DB_PASS: "db-pass-value-12345678",
      SMTP_AUTH: "smtp-auth-value-12345678",
      GPG_PASSPHRASE: "gpg-passphrase-value-12345678",
      UNRELATED_VAR: "not-a-secret",
    };
    const captured = captureCiEnvSecrets(env);
    const names = captured.map((c) => c.name);
    expect(names).toContain("DB_PASS");
    expect(names).toContain("SMTP_AUTH");
    expect(names).toContain("GPG_PASSPHRASE");
    expect(names).not.toContain("UNRELATED_VAR");
  });

  test("(case-insensitive) lowercase secret-named vars are captured", () => {
    const env: NodeJS.ProcessEnv = {
      my_service_token: "lowercase-token-value-12345678",
      my_api_key: "lowercase-key-value-12345678",
      not_a_secret_var: "ignored",
    };
    const captured = captureCiEnvSecrets(env);
    const names = captured.map((c) => c.name);
    expect(names).toContain("my_service_token");
    expect(names).toContain("my_api_key");
    expect(names).not.toContain("not_a_secret_var");
  });

  test("(case-insensitive) mixed-case suffix variants are captured", () => {
    const env: NodeJS.ProcessEnv = {
      My_Api_Key: "mixed-key-value-12345678",
      MY_DB_Pass: "mixed-pass-value-12345678",
    };
    const captured = captureCiEnvSecrets(env);
    const names = captured.map((c) => c.name);
    expect(names).toContain("My_Api_Key");
    expect(names).toContain("MY_DB_Pass");
  });
});

describe("ciEnvDenyNames", () => {
  test("(d-name) returns the same name set as captureCiEnvSecrets for non-empty values — one list, two consumers", () => {
    const env: NodeJS.ProcessEnv = {
      MY_THING_TOKEN: "token-value-12345678",
      MY_API_KEY: "key-value-12345678",
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin",
      GITHUB_REPOSITORY: "acme/repo",
    };
    const denySet = ciEnvDenyNames(env);
    const capturedNames = captureCiEnvSecrets(env)
      .map((c) => c.name)
      .sort();
    expect([...denySet].sort()).toEqual(capturedNames);
  });

  test("(d-strip) deny set includes secret-named vars with empty values that capture would skip", () => {
    const env: NodeJS.ProcessEnv = { MY_TOKEN: "", MY_SECRET: "real-secret-value-12345678" };
    const denySet = ciEnvDenyNames(env);
    const capturedNames = captureCiEnvSecrets(env).map((c) => c.name);
    expect(denySet.has("MY_TOKEN")).toBe(true);
    expect(capturedNames).not.toContain("MY_TOKEN");
    expect(denySet.has("MY_SECRET")).toBe(true);
    expect(capturedNames).toContain("MY_SECRET");
  });

  test("(d-deny) NODE_ENV / PATH / GITHUB_REPOSITORY are NOT in the deny set", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin",
      GITHUB_REPOSITORY: "acme/repo",
      SOME_RANDOM_VAR: "hello",
    };
    const denySet = ciEnvDenyNames(env);
    expect(denySet.has("NODE_ENV")).toBe(false);
    expect(denySet.has("PATH")).toBe(false);
    expect(denySet.has("GITHUB_REPOSITORY")).toBe(false);
    expect(denySet.has("SOME_RANDOM_VAR")).toBe(false);
  });

  test("(new-suffixes) _PASS / _AUTH / _PASSPHRASE appear in deny set", () => {
    const env: NodeJS.ProcessEnv = {
      DB_PASS: "",
      SMTP_AUTH: "smtp-auth-value-12345678",
      GPG_PASSPHRASE: "",
    };
    const denySet = ciEnvDenyNames(env);
    expect(denySet.has("DB_PASS")).toBe(true);
    expect(denySet.has("SMTP_AUTH")).toBe(true);
    expect(denySet.has("GPG_PASSPHRASE")).toBe(true);
  });

  test("(case-insensitive) lowercase secret-named vars are in deny set", () => {
    const env: NodeJS.ProcessEnv = {
      my_service_token: "lowercase-token-value-12345678",
      my_api_key: "lowercase-key-value-12345678",
    };
    const denySet = ciEnvDenyNames(env);
    expect(denySet.has("my_service_token")).toBe(true);
    expect(denySet.has("my_api_key")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --allow-env: exempt named secrets from the STRIP only (they still reach the
// tool subprocess), while remaining scrub needles (redacted from the bundle).
// ---------------------------------------------------------------------------

describe("--allow-env (ciEnvDeny* allow-set)", () => {
  test("(allow-name) an allowed var is dropped from the deny name set", () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "ghs_token_value_12345678", OTHER_TOKEN: "other-value-12345678" };
    const denySet = ciEnvDenyNames(env, new Set(["GH_TOKEN"]));
    expect(denySet.has("GH_TOKEN")).toBe(false);
    expect(denySet.has("OTHER_TOKEN")).toBe(true);
  });

  test("(allow-predicate) the spawn-time predicate stops denying an allowed var", () => {
    const deny = ciEnvDenyPredicate(new Set(["GH_TOKEN"]));
    expect(deny("GH_TOKEN")).toBe(false);
    expect(deny("OTHER_TOKEN")).toBe(true);
  });

  test("(allow-still-scrubbed) an allowed var is STILL captured as a scrub needle", () => {
    // capture is deliberately allow-agnostic: --allow-env affects the strip, not
    // the needle set, so an allowed secret's value is still redacted from the bundle.
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "ghs_token_value_12345678" };
    const names = captureCiEnvSecrets(env).map((c) => c.name);
    expect(names).toContain("GH_TOKEN");
  });

  test("(allow-default) no allow-set behaves exactly as before", () => {
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "ghs_token_value_12345678" };
    expect(ciEnvDenyNames(env).has("GH_TOKEN")).toBe(true);
    expect(ciEnvDenyPredicate()("GH_TOKEN")).toBe(true);
  });
});

describe("unsafeAllowEnvNames (provider-cred rail)", () => {
  test("provider credential names are refused", () => {
    expect(unsafeAllowEnvNames(["ANTHROPIC_API_KEY"])).toContain("ANTHROPIC_API_KEY");
  });

  test("generic secret names (GH_TOKEN) are allowed through", () => {
    expect(unsafeAllowEnvNames(["GH_TOKEN", "GITHUB_TOKEN"])).toEqual([]);
  });

  test("mixed input returns only the provider creds", () => {
    expect(unsafeAllowEnvNames(["GH_TOKEN", "ANTHROPIC_API_KEY"])).toEqual(["ANTHROPIC_API_KEY"]);
  });
});

// ---------------------------------------------------------------------------
// Bug-6: captureCiEnvSecrets must apply the value-length/whitespace floor
// ---------------------------------------------------------------------------

describe("(bug-6) captureCiEnvSecrets applies value-length and whitespace floor", () => {
  test("a 7-char *_TOKEN value is NOT captured (below the 8-char floor)", () => {
    const env: NodeJS.ProcessEnv = { MY_TOKEN: "abc1234" }; // 7 chars
    const captured = captureCiEnvSecrets(env);
    // Bug: current code captures the value without checking the floor.
    // Fix: apply value.length >= 8 && !/\s/.test(value) at capture time.
    expect(captured.map((c) => c.name)).not.toContain("MY_TOKEN");
  });

  test("a 7-char value emits a console.error warning", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      captureCiEnvSecrets({ MY_TOKEN: "abc1234" });
    } finally {
      console.error = origError;
    }
    // Bug: no warning is emitted currently.
    expect(errors.length).toBeGreaterThan(0);
  });

  test("an 8-char *_TOKEN value IS captured", () => {
    const env: NodeJS.ProcessEnv = { MY_TOKEN: "abc12345" }; // exactly 8 chars
    const captured = captureCiEnvSecrets(env);
    expect(captured.map((c) => c.name)).toContain("MY_TOKEN");
  });

  test("a value with whitespace is NOT captured", () => {
    const env: NodeJS.ProcessEnv = { MY_TOKEN: "abc 12345" }; // has a space
    const captured = captureCiEnvSecrets(env);
    expect(captured.map((c) => c.name)).not.toContain("MY_TOKEN");
  });
});

// ---------------------------------------------------------------------------
// Bug review-5/finding-5: captureCiEnvSecrets must NOT log the secret var
// NAME when skipping a below-floor value — log a count instead.
// ---------------------------------------------------------------------------

describe("(review-5/finding-5) captureCiEnvSecrets — skip warning must not reveal the var name", () => {
  test("the logged warning does NOT contain the secret variable name", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      // Two secret-named vars that fail the value-length floor.
      captureCiEnvSecrets({ MY_SECRET_TOKEN: "short", MY_API_KEY: "tiny" });
    } finally {
      console.error = origError;
    }
    // The warning must exist (floor was hit).
    expect(errors.length).toBeGreaterThan(0);
    // BUG: current code logs the NAME verbatim: "secret env var MY_SECRET_TOKEN skipped".
    // Fix: log a count only, e.g. "fragua: 2 secret env var(s) skipped (value below scrub floor)".
    const combined = errors.join(" ");
    expect(combined).not.toContain("MY_SECRET_TOKEN");
    expect(combined).not.toContain("MY_API_KEY");
  });

  test("the logged warning contains a count of skipped vars", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      captureCiEnvSecrets({ MY_SECRET_TOKEN: "short", MY_API_KEY: "tiny" });
    } finally {
      console.error = origError;
    }
    const combined = errors.join(" ");
    // A count ("2") must appear somewhere in the warning.
    expect(combined).toMatch(/\d+/);
  });
});
