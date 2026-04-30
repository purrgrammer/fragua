# Credentials in DB

> **Status:** DESIGN. Threat model resolves *before* [project
> extensions](./project-extensions.md) ship.

## Shape

Credentials live in the global SQLite store, encrypted at rest with a
per-platform key:

| Platform | Key store |
|---|---|
| macOS | Keychain (`security` CLI) |
| Linux | Secret Service (`libsecret`) |
| Windows | Credential Manager |

```sql
CREATE TABLE IF NOT EXISTS credentials (
  provider TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

`swarm credentials set <provider>` reads the secret from stdin (never
argv), writes ciphertext, never logs the value.

## The gap to close

Encryption-at-rest protects against:

- Disk theft / backup leakage
- Anyone with read access to the DB file but not to the keychain

Encryption-at-rest does **not** protect against:

- **In-process attackers**: any code running in the daemon process can
  call the same decryption helper the daemon uses. The OS keychain
  doesn't help — the master key is loaded into the daemon's address
  space at startup.

Today this is fine because the daemon only loads built-in handlers,
which are audited. The moment [project
extensions](./project-extensions.md) land — tools, hooks, anything
user-supplied that runs in the daemon — in-process credential
extraction is one `db.query` away.

This gap **must** be designed before tools/hooks ship. Possible
answers:

- Worker-process isolation: tools run in a spawned process with no DB
  handle. Credentials never decrypted in the worker; LLM calls proxy
  through the daemon.
- Capability-based access: tools declare which providers they need;
  the daemon supplies a scoped fetch helper, never the raw key.
- No tools network egress: trust-like-git-hooks v0 stance; tools can
  call local commands but not arbitrary HTTP.

## What this commits to

- Credentials out of process env vars. Daemon restarts no longer
  desync with the user's shell environment.
- One credential table for the whole machine; no per-project
  credentials in v0.

## What this does not commit to

- The trust-boundary answer. That's [project
  extensions](./project-extensions.md).
- Per-project credential scoping. Globalization removes the use case.
