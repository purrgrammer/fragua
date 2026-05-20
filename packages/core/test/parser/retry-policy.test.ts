// Parser tests for retry-policy attrs — authoring surface (kebab-case)
// lowered to IR (snake_case).

import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "../../src/parser/yaml.ts";

describe("parseWorkflow — retry-policy attrs", () => {
  test("parses node-level retry-policy preset name", () => {
    const g = parseWorkflow(`
name: t
steps:
  flaky:
    type: llm
    prompt: x
    retry-policy: standard
    next: exit
`);
    expect(g.nodes["flaky"]?.attrs.retry_policy).toBe("standard");
  });

  test("parses the four per-node override attrs with correct types", () => {
    const g = parseWorkflow(`
name: t
steps:
  flaky:
    type: llm
    prompt: x
    retry-policy: standard
    retry-initial-delay-ms: 50
    retry-backoff-factor: 1.5
    retry-max-delay-ms: 5000
    retry-jitter: false
    next: exit
`);
    const attrs = g.nodes["flaky"]?.attrs;
    expect(attrs?.retry_initial_delay_ms).toBe(50);
    expect(attrs?.retry_backoff_factor).toBe(1.5);
    expect(attrs?.retry_max_delay_ms).toBe(5000);
    expect(attrs?.retry_jitter).toBe(false);
  });

  test("parses graph-level default-retry-policy", () => {
    const g = parseWorkflow(`
name: t
default-retry-policy: aggressive
steps:
  work:
    type: llm
    prompt: x
    next: exit
`);
    expect(g.attrs.default_retry_policy).toBe("aggressive");
  });

  test("retry-initial-delay-ms and retry-max-delay-ms are coerced to integers", () => {
    const g = parseWorkflow(`
name: t
steps:
  flaky:
    type: llm
    prompt: x
    retry-initial-delay-ms: 100.9
    retry-max-delay-ms: 30000.7
    next: exit
`);
    const attrs = g.nodes["flaky"]?.attrs;
    expect(attrs?.retry_initial_delay_ms).toBe(100);
    expect(attrs?.retry_max_delay_ms).toBe(30000);
  });

  test("retry-jitter: true parses as boolean true", () => {
    const g = parseWorkflow(`
name: t
steps:
  flaky:
    type: llm
    prompt: x
    retry-jitter: true
    next: exit
`);
    expect(g.nodes["flaky"]?.attrs.retry_jitter).toBe(true);
  });
});
