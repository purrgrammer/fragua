// Integration assertion: `fragua daemon` wires the bash env-strip from
// `resolveEnvPassthrough(config) → daemonEnvDeny(...) →
// WorktreeProvisioner({ envDenyNames, envDenyPredicate })`. Parallel to
// `ci-env-deny-wiring.test.ts`, this proves the daemon path strips provider
// credentials, honours a generic passthrough, and refuses a provider
// credential listed in `bash.env-passthrough` — without booting a daemon.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeProvisioner } from "@fragua/daemon";
import { loadConfig, resolveEnvPassthrough } from "../src/config.ts";
import { daemonEnvDeny } from "../src/env-creds.ts";

describe("daemon wires resolveEnvPassthrough → daemonEnvDeny → WorktreeProvisioner", () => {
  const ENV_KEYS = ["ANTHROPIC_API_KEY", "GH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "AONLY_TOKEN", "BONLY_TOKEN"] as const;
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
    process.env["ANTHROPIC_OAUTH_TOKEN"] = "sk-ant-oat-value-12345678";

    // Config lists a legitimate CI token plus two provider creds that must be refused.
    const passthrough = resolveEnvPassthrough({
      bash: { "env-passthrough": ["GH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] },
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
    expect(effective.has("ANTHROPIC_OAUTH_TOKEN")).toBe(false);
    expect(names.has("GH_TOKEN")).toBe(false);
    expect(names.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(names.has("ANTHROPIC_OAUTH_TOKEN")).toBe(true);
    expect(predicate("GH_TOKEN")).toBe(false);
    expect(predicate("ANTHROPIC_API_KEY")).toBe(true);
    expect(predicate("ANTHROPIC_OAUTH_TOKEN")).toBe(true);
    expect(warnings.join(" ")).toContain("fragua providers");

    // The pair wires into the provisioner without error — the daemon's exact call shape.
    // This asserts only that the constructor accepts the options; the end-to-end
    // proof that `envDenyPredicate` actually reaches the spawned subprocess env
    // lives in `@fragua/workspace`'s `worktree-env.test.ts`
    // ("envDenyPredicate: predicate-denied var is absent from git subprocess env").
    const provisioner = new WorktreeProvisioner({ envDenyNames: names, envDenyPredicate: predicate });
    expect(provisioner).toBeInstanceOf(WorktreeProvisioner);
  });

  test("(daemon-wire-per-run) each project's bash.env-passthrough is resolved per run, independent of launch cwd", async () => {
    const homeDir = mkdtempSync(join(tmpdir(), "fragua-home-"));
    const projA = mkdtempSync(join(tmpdir(), "fragua-projA-"));
    const projB = mkdtempSync(join(tmpdir(), "fragua-projB-"));
    for (const [dir, name] of [
      [projA, "AONLY_TOKEN"],
      [projB, "BONLY_TOKEN"],
    ] as const) {
      mkdirSync(join(dir, ".fragua"), { recursive: true });
      writeFileSync(join(dir, ".fragua/config.yaml"), `bash:\n  env-passthrough:\n    - ${name}\n`);
    }
    process.env["AONLY_TOKEN"] = "a-token-value-12345678";
    process.env["BONLY_TOKEN"] = "b-token-value-12345678";

    // The same closure `daemonCommand` builds for `resolveRunEnvDeny`, but with an
    // isolated homeDir so a real ~/.fragua/config.yaml can't skew the assertion.
    const resolveRunEnvDeny = async (cwd: string) => {
      const cfg = await loadConfig(cwd, { homeDir });
      return daemonEnvDeny({ passthrough: resolveEnvPassthrough(cfg) });
    };

    const a = await resolveRunEnvDeny(projA);
    const b = await resolveRunEnvDeny(projB);
    // Project A re-admits only its own token; project B only its own.
    expect(a.names.has("AONLY_TOKEN")).toBe(false);
    expect(a.names.has("BONLY_TOKEN")).toBe(true);
    expect(b.names.has("BONLY_TOKEN")).toBe(false);
    expect(b.names.has("AONLY_TOKEN")).toBe(true);
  });
});
