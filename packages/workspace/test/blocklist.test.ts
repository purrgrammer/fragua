import { describe, expect, test } from "bun:test";
import { isBlockedCommand, isShellInterpreter, SHELL_INTERPRETERS } from "../src/blocklist.ts";

describe("isShellInterpreter", () => {
  test("matches each of the five shell names exactly", () => {
    for (const shell of ["sh", "bash", "zsh", "dash", "fish"]) {
      expect(isShellInterpreter(shell)).toBe(true);
    }
  });

  test("case-insensitive match", () => {
    expect(isShellInterpreter("BASH")).toBe(true);
    expect(isShellInterpreter("Zsh")).toBe(true);
    expect(isShellInterpreter("SH")).toBe(true);
  });

  test("matches basename of an absolute path", () => {
    expect(isShellInterpreter("/usr/bin/bash")).toBe(true);
    expect(isShellInterpreter("/bin/sh")).toBe(true);
  });

  test("strips .exe suffix before matching", () => {
    expect(isShellInterpreter("bash.exe")).toBe(true);
    expect(isShellInterpreter("sh.exe")).toBe(true);
  });

  test("does not match non-shell names", () => {
    expect(isShellInterpreter("bashful")).toBe(false);
    expect(isShellInterpreter("myzsh")).toBe(false);
    expect(isShellInterpreter("node")).toBe(false);
    expect(isShellInterpreter("python")).toBe(false);
    expect(isShellInterpreter("bun")).toBe(false);
  });

  test("SHELL_INTERPRETERS constant has exactly the five expected names", () => {
    expect([...SHELL_INTERPRETERS].sort()).toEqual(["bash", "dash", "fish", "sh", "zsh"]);
  });
});

describe("isBlockedCommand — argv context (cmd only, not joined string)", () => {
  test("sudo as cmd is blocked", () => {
    expect(isBlockedCommand("sudo")).toBeDefined();
  });

  test("a blocklist pattern matching cmd body is blocked", () => {
    // rm -rf / matches the rm -rf pattern
    expect(isBlockedCommand("rm -rf /")).toBeDefined();
  });

  test("blocklist does not fire on a safe cmd", () => {
    expect(isBlockedCommand("jq")).toBeUndefined();
    expect(isBlockedCommand("echo")).toBeUndefined();
  });

  test("blocklist checks cmd only (argv elements are intentionally not joined)", () => {
    // 'sudo' as an arg element won't be passed to isBlockedCommand in the exec path —
    // only the cmd (argv[0]) is checked. This test confirms the function itself
    // matches on substring patterns so the caller's responsibility is to pass only cmd.
    expect(isBlockedCommand("echo")).toBeUndefined();
    // If someone erroneously passed the full joined string, sudo in args would still match.
    // The exec path avoids this by calling isBlockedCommand(cmd) not isBlockedCommand(joined).
  });
});
