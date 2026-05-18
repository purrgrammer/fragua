#!/usr/bin/env bash
# detect-runner.sh — discover the project's test command from manifest files.
#
# Emits a single line on stdout — the test command to run, with no quoting
# or shell metacharacters (caller substitutes it verbatim into `$detect_test_runner.output`).
# Exits 0 with the command on a recognised manifest, exits 1 with an error on stderr otherwise.

set -euo pipefail

if [ -f package.json ]; then
  if [ -f bun.lockb ] || [ -f bun.lock ]; then
    echo "bun test"
  elif [ -f pnpm-lock.yaml ]; then
    echo "pnpm test"
  elif [ -f yarn.lock ]; then
    echo "yarn test"
  else
    echo "npm test"
  fi
elif [ -f pyproject.toml ] || [ -f setup.py ] || [ -f tox.ini ]; then
  if command -v tox >/dev/null 2>&1; then
    echo "tox"
  else
    echo "pytest"
  fi
elif [ -f Cargo.toml ]; then
  echo "cargo test --workspace"
elif [ -f go.mod ]; then
  echo "go test ./..."
elif [ -f composer.json ]; then
  echo "composer test"
elif [ -f Gemfile ] && [ -f Rakefile ]; then
  echo "bundle exec rake test"
elif [ -f mix.exs ]; then
  echo "mix test"
elif [ -f Makefile ] && grep -qE '^(test|check|ci):' Makefile; then
  echo "make test"
else
  echo "detect-runner: no recognised test runner found" >&2
  exit 1
fi
