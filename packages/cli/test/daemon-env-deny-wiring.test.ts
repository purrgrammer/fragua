// Integration assertion: `fragua daemon` wires the bash env-strip from
// `resolveEnvPassthrough(config) → daemonEnvDeny(...) →
// WorktreeProvisioner({ envDenyNames, envDenyPredicate })`. Parallel to
// `ci-env-deny-wiring.test.ts`, this proves the daemon path strips provider
// credentials, honours a generic passthrough, and refuses a provider
// credential listed in `bash.env-passthrough` — without booting a daemon.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WorktreeProvisioner } from "@fragua/daemon";
import { resolveEnvPassthrough } from "../src/config.ts";
import { daemonEnvDeny } from "../src/env-creds.ts";

describe("daemon wires resolveEnvPassthrough → daemonEnvDeny → WorktreeProvisioner", () => {
  const ENV_KEYS = ["ANTHROPIC_API_KEY", "GH_TOKEN", "OPENAI_OAUTH_TOKEN"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("(daemon-wire) a generic passthrough reaches WorktreeProvisioner while provider creds are refused", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-value-12345678";
    process.env["GH_TOKEN"] = "ghs_token_value_12345678";
    process.env["OPENAI_OAUTH_TOKEN"] = "sk-oai-oauth-value-12345678";

    // Config lists a legitimate CI token plus two provider creds that must be refused.
    const passthrough = resolveEnvPassthrough({
      bash: { "env-passthrough": ["GH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_OAUTH_TOKEN"] },
    });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    let names: Set<string>;
    let predicate: (name: string) => boolean;
    let effective: ReadonlySet<string>;
    try {
      const deny = daemonEnvDeny({ passthrough });
      names = deny.names;
      predicate = deny.predicate;
      effective = deny.passthrough;
    } finally {
      console.warn = origWarn;
    }

    // GH_TOKEN survives; both provider creds are refused and stripped.
    expect(effective.has("GH_TOKEN")).toBe(true);
    expect(effective.has("ANTHROPIC_API_KEY")).toBe(false);
    expect(effective.has("OPENAI_OAUTH_TOKEN")).toBe(false);
    expect(names.has("GH_TOKEN")).toBe(false);
    expect(names.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(names.has("OPENAI_OAUTH_TOKEN")).toBe(true);
    expect(predicate("GH_TOKEN")).toBe(false);
    expect(predicate("ANTHROPIC_API_KEY")).toBe(true);
    expect(predicate("OPENAI_OAUTH_TOKEN")).toBe(true);
    expect(warnings.join(" ")).toContain("fragua providers");

    // The pair wires into the provisioner without error — the daemon's exact call shape.
    const provisioner = new WorktreeProvisioner({ envDenyNames: names, envDenyPredicate: predicate });
    expect(provisioner).toBeInstanceOf(WorktreeProvisioner);
  });
});
