// Integration assertion: `fragua daemon` wires the bash env allow-list from
// `resolveEnvPassthrough(config) → daemonEnvAllow(...) →
// WorktreeProvisioner({ envAllowNames })`. Parallel to `ci`'s allow-list path,
// this proves the daemon path allows a generic passthrough, refuses a provider
// credential listed in `bash.env-passthrough`, and resolves per project —
// without booting a daemon.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeProvisioner } from "@fragua/daemon";
import { loadConfig, resolveEnvPassthrough } from "../src/config.ts";
import { daemonEnvAllow } from "../src/env-creds.ts";

describe("daemon wires resolveEnvPassthrough → daemonEnvAllow → WorktreeProvisioner", () => {
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
    // Config lists a legitimate CI token plus two provider creds that must be refused.
    const passthrough = resolveEnvPassthrough({
      bash: { "env-passthrough": ["GH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] },
    });

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    let allow: ReadonlySet<string>;
    let refused: string[];
    try {
      const resolved = daemonEnvAllow({ passthrough });
      allow = resolved.allow;
      refused = resolved.refused;
    } finally {
      console.warn = origWarn;
    }

    // GH_TOKEN survives on the allow-list; both provider creds are refused.
    expect(allow.has("GH_TOKEN")).toBe(true);
    expect(allow.has("ANTHROPIC_API_KEY")).toBe(false);
    expect(allow.has("ANTHROPIC_OAUTH_TOKEN")).toBe(false);
    expect(refused).toContain("ANTHROPIC_API_KEY");
    expect(refused).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(warnings.join(" ")).toContain("fragua providers");

    // The allow-list wires into the provisioner without error — the daemon's
    // exact call shape. This asserts only that the constructor accepts the
    // options; the end-to-end proof that `envAllowNames` actually gates the
    // spawned subprocess env lives in `@fragua/workspace`'s `local-env.test.ts`.
    const provisioner = new WorktreeProvisioner({ envAllowNames: allow });
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

    // The same closure `daemonCommand` builds for `resolveRunEnvAllow`, but with
    // an isolated homeDir so a real ~/.fragua/config.yaml can't skew the assertion.
    const resolveRunEnvAllow = async (cwd: string) => {
      const cfg = await loadConfig(cwd, { homeDir });
      return daemonEnvAllow({ passthrough: resolveEnvPassthrough(cfg) });
    };

    const a = await resolveRunEnvAllow(projA);
    const b = await resolveRunEnvAllow(projB);
    // Project A allows only its own token; project B only its own.
    expect(a.allow.has("AONLY_TOKEN")).toBe(true);
    expect(a.allow.has("BONLY_TOKEN")).toBe(false);
    expect(b.allow.has("BONLY_TOKEN")).toBe(true);
    expect(b.allow.has("AONLY_TOKEN")).toBe(false);
  });
});
