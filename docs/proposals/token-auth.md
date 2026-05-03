---
title: Token auth for the harness API
status: deferred
maturity: sketch
last-reviewed: 2026-05-03
---

# Token auth for the harness API

> Deferred. The v0 harness is localhost-only, no auth — the trust
> boundary is filesystem permissions on `~/.swarm/swarm.db` (0600).
> Token auth lands when the threat model widens beyond a single-user
> laptop.

## When this becomes load-bearing

- **Hostile browser tab on `localhost`.** Today's web UI shares an
  origin with the API; a malicious tab in the same browser can fetch
  `/api/runs` without any token.
- **Shared dev box.** Multiple Unix users on the same machine can
  read each other's `~/.swarm/swarm.db` if home perms are sloppy
  (or if some path is symlinked). Filesystem perms aren't a reliable
  boundary in that world.
- **Cloud / remote dev environment.** The harness API is exposed
  over a tunnel or port-forward; any process on the network can
  reach it.

None of these apply to a single-user laptop running the harness
locally — the v0 default.

## Shape (when it ships)

`daemon_lock` gains an `auth_token TEXT` column. The harness mints
a random token on first start and stores it. CLIs read the token
from the DB and send it as `Authorization: Bearer <token>`. The
web UI reads it at boot. Server middleware rejects requests
without a valid token.

`--no-auth` flag for the CI primitives where there's already an
explicit `--db <path>` boundary.

## Open questions

- **Per-project tokens** (read-only? scoped?). Probably overkill
  for v1; `~/.swarm/swarm.db` is one shared resource, not a
  permission system.
- **Unix socket transport instead.** Cleaner boundary on macOS /
  Linux, but the web UI talks HTTP — would need a proxy. TBD.
- **Token rotation.** Manual `swarm harness reset-token` is enough
  to start.
- **CSRF.** Once the web UI carries a bearer token, same-origin
  fetch is the attack vector. Document the assumption or move to
  cookie-with-CSRF-token model.
