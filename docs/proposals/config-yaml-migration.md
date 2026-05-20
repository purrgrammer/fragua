---
title: YAML as canonical config format
status: in-progress
---

# YAML as canonical config format

> Status: in-progress — the loader and `swarm init` changes shipped; the removal of the JSONC reader is deferred.

## What changed

`config.yaml` is now the canonical config file for both layers of the config cascade:

- global: `~/.swarm/config.yaml`
- project: `<cwd>/.swarm/config.yaml`

`swarm init` writes `config.yaml`. The config schema (`SwarmConfigSchema`) is unchanged — only the on-disk serialisation format flips.

## Deprecation policy

The `config.jsonc` reader remains active for one release with the following behaviour:

- **Only `.yaml` present** — loaded silently (normal path).
- **Only `.jsonc` present** — loaded with a `console.warn` per layer:
  ```
  config (project): <path>/config.jsonc is deprecated — rename it to config.yaml to silence this warning
  ```
- **Both present in the same layer** — YAML wins; JSONC is ignored with a `console.warn`:
  ```
  config (project): <path>/config.jsonc is shadowed by <path>/config.yaml — delete the .jsonc file to silence this warning
  ```

## Migration steps

1. Rename the file: `mv .swarm/config.jsonc .swarm/config.yaml`
2. Convert the content — YAML is a superset of JSON so a valid JSON object is also valid YAML. Comments (`# …`) replace `// …` and `/* … */` syntax.
3. Run `swarm validate` on any workflows to confirm the daemon picks up the new config correctly.

Example before (`config.jsonc`):
```jsonc
{
  // pin the default model
  "defaults": {
    "llm_provider": "anthropic",
    "llm_model": "claude-sonnet-4.7"
  },
  "bootstrap": "bun install --frozen-lockfile"
}
```

Example after (`config.yaml`):
```yaml
# pin the default model
defaults:
  provider: anthropic
  model: claude-sonnet-4.7
bootstrap: "bun install --frozen-lockfile"
```

## Removal milestone

The JSONC reader will be removed in the release following the one that ships this notice. At that point, a `config.jsonc`-only setup will silently get `{}` (the missing-file behaviour) rather than the deprecated-but-working load. Users who have not migrated by then will see their config ignored with no warning.

## Rationale

- YAML is already the format for all workflow files (`.swarm/workflows/*.yaml`). Unifying on one format reduces the number of parsers in the bundle.
- YAML supports comments natively (`#`) without a separate spec layer.
- The `yaml@2.7.0` package is already a dependency of `@swarm/core` and `@swarm/workspace` — adding it to `@swarm/cli` and `@swarm/web` adds no new transitive dependencies.
- `jsonc-parser` is removed from `@swarm/cli`'s dependency list.
