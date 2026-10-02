// env → store credential bridge. `fragua ci` runs against an ephemeral store
// with no `fragua providers add` history, so it seeds the store's
// `provider_credentials` rows from the conventional credential env vars before
// the executor assembly reads them. Store-backed resolution then runs
// unchanged — this is a one-time seed, not a new resolution path on
// AuthStorage.
//
// We seed *every* provider pi-ai knows an env var for (`getProviders()` is the
// full registry), not a curated subset — anything pi-ai can route to, CI can
// authenticate. The env→var map and provider list are pi-ai's own, so CI and
// the rest of the ecosystem agree on which variable feeds which provider.
//
// One credential type covers everything. `getEnvApiKey` returns whatever the
// provider needs as a bare string: a raw API key, or an OAuth access token
// (e.g. `ANTHROPIC_OAUTH_TOKEN`, which pi-ai prefers over `ANTHROPIC_API_KEY`).
// The provider decides the wire auth scheme from the value — the anthropic
// provider switches to Bearer + Claude-Code identity headers when it sees the
// `sk-ant-oat` OAuth prefix — so a single `api_key` row carries both. Env can
// only supply a bare access token (no refresh material), so `oauth`-typed
// rows, which exist to drive token refresh, are never the right shape here.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { findEnvKeys, getEnvApiKey, getProviders } from "@earendil-works/pi-ai/compat";
import { AuthStorage, getFraguaHome } from "@fragua/agent";
import { JUDGE_DEFAULT_PROVIDER } from "@fragua/core";
import { type IProviderCredentialStore, SqliteStore } from "@fragua/store";
import { portableOAuthBlob } from "@fragua/workspace";
import chalk from "chalk";

// pi-ai's github-copilot env fallback includes the generic GH_TOKEN /
// GITHUB_TOKEN, which are set in virtually every GitHub Actions job for the
// `gh` CLI and have nothing to do with Copilot. Seeding copilot from one of
// those would register a bogus provider, so we only honor copilot when its
// dedicated COPILOT_GITHUB_TOKEN is what resolved.
const COPILOT_AMBIENT_ENV = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

/**
 * Provider-credential env names refused regardless of whether pi-ai's provider
 * registry is loaded. `buildProviderCredentialContext()` is registration-gated
 * — empty early in `fragua ci` and in unit tests — so the rail can't rely on it
 * alone. These are the LLM-provider creds fragua reads directly; they must never
 * reach a tool subprocess. (`_API_KEY` covers the shape virtually every provider
 * key follows; the explicit names cover non-`_API_KEY` creds like the OAuth token.)
 *
 * `TYPESAFE_API_KEY` is the judge (System One) credential. That provider is not
 * in pi-ai's registry at all, so the context builder can never name it however
 * late it runs — this set is the only thing that refuses it.
 */
const ALWAYS_PROVIDER_CRED: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "TYPESAFE_API_KEY",
  "OLLAYA_API_KEY",
]);

// ---------------------------------------------------------------------------
// CI env secret capture
// ---------------------------------------------------------------------------

/** Name suffixes that mark an env var as a likely secret (default-deny list).
 * Only names matching one of these suffixes (or in the known-provider-var set)
 * are captured as needles. Everything else is NOT a needle.
 *
 * Matching is case-insensitive (checked via name.toUpperCase()). Do NOT add
 * broad suffixes like _URL — DATABASE_URL is covered by the conn_string_userinfo
 * pattern; a blanket _URL would over-strip non-secret variables. */
const CI_ENV_SECRET_SUFFIXES = [
  "_KEY",
  "_SECRET",
  "_TOKEN",
  "_PASSWORD",
  "_CREDENTIAL",
  "_PASS",
  "_AUTH",
  "_PASSPHRASE",
] as const;

/** Pre-computed provider-credential lookup context: pi-ai's registry walked
 * ONCE. `varNames` = the env-var names pi-ai maps to a provider (minus the
 * ambient CI tokens); `prefixes` = each provider's conventional env-var prefix
 * (`openai` → `OPENAI`). Build once per operation and thread through the gates
 * so a single call can't walk `getProviders()` several times or observe a
 * registry that changed mid-flight. */
export interface ProviderCredentialContext {
  varNames: Set<string>;
  prefixes: Set<string>;
}

/** Walk pi-ai's provider registry once, collecting both the known env-var
 * names (minus COPILOT_AMBIENT_ENV) and the per-provider prefixes. Exported so
 * a caller with several gate calls (both CI deny sites, the daemon startup)
 * can build the static context ONCE and thread it through, instead of each
 * function re-walking `getProviders()`. */
export function buildProviderCredentialContext(): ProviderCredentialContext {
  const varNames = new Set<string>();
  const prefixes = new Set<string>();
  for (const provider of getProviders()) {
    prefixes.add(providerEnvPrefix(provider));
    for (const name of findEnvKeys(provider) ?? []) {
      // Same COPILOT_AMBIENT_ENV denial as seedCredsFromEnv so GH_TOKEN /
      // GITHUB_TOKEN aren't admitted as needles when COPILOT_GITHUB_TOKEN is unset.
      if (!COPILOT_AMBIENT_ENV.has(name)) varNames.add(name);
    }
  }
  return { varNames, prefixes };
}

/**
 * True when an env var NAME is an LLM-provider credential fragua reads directly
 * — the shape that must NEVER reach a bash subprocess or an exported bundle.
 * Four independent gates so provider attribution doesn't hinge on registry
 * timing or a single suffix:
 *  1. present in pi-ai's live env-var registry (`ctx.varNames`);
 *  2. one of the always-refused static names (`ALWAYS_PROVIDER_CRED`);
 *  3. `_API_KEY` shape (virtually every provider key);
 *  4. a `CI_ENV_SECRET_SUFFIXES` suffix stripped off leaves a prefix that is
 *     EXACTLY a provider prefix (`OPENAI_SECRET` → `OPENAI`), catching
 *     non-`_API_KEY` creds absent from the registry. The match is exact — a var
 *     whose prefix merely *starts with* a provider prefix (`OPENAI_PROXY_AUTH`)
 *     is NOT a provider credential and stays re-admittable. A held custom
 *     provider's odd-shaped creds are covered separately by the storeProviders
 *     prefix scan in {@link daemonEnvAllow}.
 * The ambient CI tokens (`GH_TOKEN`, `GITHUB_TOKEN`) are short-circuited to
 * non-credential so a future bare `github` provider prefix can't reclassify them.
 */
function isProviderCredential(name: string, ctx: ProviderCredentialContext): boolean {
  if (COPILOT_AMBIENT_ENV.has(name)) return false;
  const upper = name.toUpperCase();
  if (ctx.varNames.has(name) || ALWAYS_PROVIDER_CRED.has(upper) || upper.endsWith("_API_KEY")) {
    return true;
  }
  const suffix = CI_ENV_SECRET_SUFFIXES.find((s) => upper.endsWith(s));
  if (suffix === undefined) return false;
  const prefix = upper.slice(0, -suffix.length);
  return ctx.prefixes.has(prefix);
}

/** The conventional env-var prefix for a provider NAME (`custom-ai` →
 * `CUSTOM_AI`). Shared by the storeProviders loop and the refusal gate so both
 * derive the prefix identically. */
function providerEnvPrefix(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** True when a name is a held-provider credential fragua reads directly but
 * pi-ai's static registry can't name — a secret-shaped var carrying the
 * `<PREFIX>_` of a store-held provider (`CUSTOMAI_OAUTH_TOKEN`,
 * `ANTHROPIC_RATE_LIMIT_TOKEN`). Complements {@link isProviderCredential}'s
 * exact-prefix gate 4: this is the ONE decision function the daemon deny surface
 * uses so `names`, `predicate`, and the passthrough refusal filter can't
 * disagree on the same input. */
function matchesStoreProviderPrefix(
  name: string,
  storeProviderPrefixes: ReadonlySet<string>,
  ctx: ProviderCredentialContext,
): boolean {
  // Same COPILOT_AMBIENT_ENV short-circuit as `isProviderCredential` — without
  // it, a `github`-prefixed store provider would reclassify the ambient CI
  // tokens (GH_TOKEN / GITHUB_TOKEN) as provider credentials and silently strip
  // them, even though the first refusal branch spares them.
  if (COPILOT_AMBIENT_ENV.has(name)) return false;
  if (storeProviderPrefixes.size === 0) return false;
  const upper = name.toUpperCase();
  for (const prefix of storeProviderPrefixes) {
    if (upper.startsWith(`${prefix}_`) && isSecretEnvName(name, ctx)) return true;
  }
  return false;
}

/** Build the set of per-provider env-var prefixes for the held-provider prefix
 * scan (`custom-ai` → `CUSTOM_AI`). Shared by both the CI `--allow-env` rail
 * and the daemon deny rail so the two can't disagree on the prefix set. */
export function buildStoreProviderPrefixes(providers: Iterable<string>): Set<string> {
  const prefixes = new Set<string>();
  for (const provider of providers) prefixes.add(providerEnvPrefix(provider));
  return prefixes;
}

/** The ONE classification gate both provider-credential rails call: true when a
 * name is refused from bash env-passthrough / `--allow-env` because fragua reads
 * it directly as a provider credential. Collapses the two-branch compound
 * predicate (`isProviderCredential` OR the held-provider prefix scan) so a new
 * gate added here can't miss one rail — CI and daemon must never disagree at
 * this security boundary. */
export function isDeniedEnvName(
  name: string,
  ctx: ProviderCredentialContext,
  storeProviderPrefixes: ReadonlySet<string>,
): boolean {
  return isProviderCredential(name, ctx) || matchesStoreProviderPrefix(name, storeProviderPrefixes, ctx);
}

/** Returns true when an env var NAME indicates it is secret, regardless
 * of the value. Shared predicate for both `captureCiEnvSecrets` (which
 * also checks the value is non-empty) and the held-provider prefix scan. */
function isSecretEnvName(name: string, ctx: ProviderCredentialContext): boolean {
  const upper = name.toUpperCase();
  const isSecretSuffix = CI_ENV_SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix));
  return isSecretSuffix || ctx.varNames.has(name);
}

/**
 * Capture env entries whose NAME indicates a secret (default-deny by name).
 * Returns `{ name, value }` pairs; empty values are excluded. The registry's
 * own value-length floor (8 chars + no whitespace) handles very-short values.
 *
 * Rules (applied in order):
 *  1. Name suffix matches one of `CI_ENV_SECRET_SUFFIXES`.
 *  2. Name appears in the pi-ai known-provider-var set (minus COPILOT_AMBIENT_ENV).
 * Default-DENY: names that match neither rule are NOT captured regardless of
 * their value (GITHUB_REPOSITORY, NODE_ENV, PATH, etc.).
 *
 * @param env - defaults to `process.env`; injectable for tests.
 */
export function captureCiEnvSecrets(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; value: string }> {
  const ctx = buildProviderCredentialContext();
  const result: Array<{ name: string; value: string }> = [];
  let skipped = 0;
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (!isSecretEnvName(name, ctx)) continue;
    if (value.length < 8 || /\s/.test(value)) {
      skipped++;
      continue;
    }
    result.push({ name, value });
  }
  if (skipped > 0) {
    console.error(`fragua: ${skipped} secret env var(s) skipped (value below scrub floor — will NOT be scrubbed)`);
  }
  return result;
}

/** Shared empty allow-set so the default path allocates nothing. */
const NO_ALLOW: ReadonlySet<string> = new Set();

/**
 * Resolve the bash-tool env ALLOW-LIST for `fragua daemon` (hence the harness)
 * under the deny-by-default model. The shell inherits the built-in baseline
 * (PATH/HOME/…, applied in `LocalEnvironment`) PLUS the names this returns;
 * everything else — provider credentials, ambient secrets, unrelated vars —
 * never reaches the shell.
 *
 * `passthrough` is the operator's `bash.env-passthrough` list. A provider
 * credential listed there is REFUSED — the same rail as ci's `--allow-env`
 * (`unsafeAllowEnvNames`): a workflow may allow generic secrets (GH_TOKEN, …)
 * but never an LLM-provider key fragua reads directly. `storeProviders` extends
 * the refusal to custom store-only providers pi-ai's static registry can't name
 * (a secret-shaped var carrying a held provider's prefix).
 *
 * Returns the EFFECTIVE `allow` (requested minus refused) so callers wire the
 * set that actually took effect, and the `refused` names so callers surface them
 * (pointing at `fragua providers` as the right place to hold a credential).
 */
export function daemonEnvAllow(
  opts: {
    storeProviders?: Iterable<string>;
    passthrough?: ReadonlySet<string>;
    ctx?: ProviderCredentialContext;
    /** Emit a `console.warn` naming refused passthrough entries. Default true.
     * The daemon sets `false` and surfaces refusals ONCE in its startup log
     * instead of on every per-run provision. */
    warn?: boolean;
  } = {},
): { allow: ReadonlySet<string>; refused: string[] } {
  const requested = opts.passthrough ?? NO_ALLOW;
  const ctx = opts.ctx ?? buildProviderCredentialContext();
  const storeProviderPrefixes = buildStoreProviderPrefixes([...(opts.storeProviders ?? [])]);
  const refused = [...requested].filter((n) => isDeniedEnvName(n, ctx, storeProviderPrefixes));
  const allow: ReadonlySet<string> =
    refused.length === 0 ? requested : new Set([...requested].filter((n) => !refused.includes(n)));
  if (refused.length > 0 && (opts.warn ?? true)) {
    console.warn(
      `fragua: refusing to pass provider credential(s) through bash.env-passthrough: ${JSON.stringify(refused)} — ` +
        `hold provider credentials with \`fragua providers\`, not env-passthrough`,
    );
  }
  return { allow, refused };
}

/** Judge (System One) providers — not in pi-ai's registry, so their env vars
 * are seeded explicitly alongside the pi-ai providers. A local runtime usually
 * enforces no key at all; the var matters when the operator set one, and the
 * always-strip set keeps it out of a tool step's shell either way. */
const JUDGE_ENV: ReadonlyArray<readonly [provider: string, envVar: string]> = [
  [JUDGE_DEFAULT_PROVIDER, "TYPESAFE_API_KEY"],
  ["ollaya", "OLLAYA_API_KEY"],
];

/**
 * Validate a `--allow-env` request: return the names that must NOT be exempted
 * from the CI env-strip. A provider-credential var (e.g. `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_OAUTH_TOKEN`) must never reach a tool subprocess — fragua reads it
 * directly for the provider, and a public/team-readable bundle is an
 * exfiltration target. Generic `*_TOKEN` / `*_KEY` secrets (GH_TOKEN, …) ARE
 * allowed through — that's the flag's purpose. The caller refuses the run when
 * this returns a non-empty list.
 *
 * `storeProviders` (the global store's `authStorage.list()` snapshot) extends
 * the gate to custom, store-only providers pi-ai's static registry can't name:
 * a secret-shaped var carrying a held provider's prefix (`CUSTOMAI_OAUTH_TOKEN`
 * for a `customai` provider) is refused too — the same prefix scan
 * {@link daemonEnvAllow} uses, so the CI `--allow-env` rail and the daemon
 * allow-list agree on which names are provider credentials.
 */
export function unsafeAllowEnvNames(allow: Iterable<string>, storeProviders: Iterable<string> = []): string[] {
  const ctx = buildProviderCredentialContext();
  const storeProviderPrefixes = buildStoreProviderPrefixes(storeProviders);
  const bad: string[] = [];
  for (const name of allow) {
    // Shared with `daemonEnvAllow`'s refusal filter via `isDeniedEnvName`. The
    // legitimate allow case is CI platform tokens (GH_TOKEN, …) which attribute
    // to no provider.
    if (isDeniedEnvName(name, ctx, storeProviderPrefixes)) bad.push(name);
  }
  return bad;
}

/**
 * List the provider names held in the GLOBAL store (what `fragua providers add`
 * wrote), for threading into {@link unsafeAllowEnvNames} so `fragua ci
 * --allow-env` refuses a custom provider's credentials too. Returns `[]` when
 * there is no global store (a fresh CI machine). Opens the store read-only and
 * closes it — a one-shot snapshot, not a live subscription.
 */
export function listGlobalStoreProviders(globalPath: string = resolve(getFraguaHome(), "fragua.db")): string[] {
  if (!existsSync(globalPath)) return [];
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore({ path: globalPath, migrate: false });
    return AuthStorage.fromStore(store).list();
  } catch (err) {
    // A schema/binary mismatch or an open failure on the global store must not
    // take out `fragua ci` before the workflow is read — the rail already treats
    // "no global store" as `[]`, and a version-mismatch store is safely
    // equivalent (the custom-provider prefix extension just goes unused).
    console.warn(chalk.yellow(`fragua: ignoring unreadable global store at ${globalPath}: ${(err as Error).message}`));
    return [];
  } finally {
    store?.close();
  }
}

/**
 * Seed `store`'s `provider_credentials` rows from the conventional credential
 * env vars. Returns the providers that were seeded (had a usable token in
 * env), so the caller can surface "running against anthropic (from env)" or
 * warn when nothing resolved.
 */
export function seedCredsFromEnv(store: IProviderCredentialStore): string[] {
  const auth = AuthStorage.fromStore(store);
  const seeded: string[] = [];
  for (const provider of getProviders()) {
    const key = getEnvApiKey(provider);
    // `<authenticated>` is the ambient-credential sentinel (Bedrock AWS
    // profile / Vertex ADC) — not a literal token, so it can't be stored as
    // an api_key row. Those need their own bridge if CI ever targets them.
    if (!key || key === "<authenticated>") continue;
    if (provider === "github-copilot") {
      const sources = findEnvKeys(provider) ?? [];
      if (sources.every((s) => COPILOT_AMBIENT_ENV.has(s))) continue;
    }
    auth.set(provider, { type: "api_key", key });
    seeded.push(provider);
  }
  for (const [provider, envVar] of JUDGE_ENV) {
    const key = process.env[envVar];
    if (!key) continue;
    auth.set(provider, { type: "api_key", key });
    seeded.push(provider);
  }
  return seeded;
}

/**
 * Seed `target` from the GLOBAL store's configured providers — what `fragua
 * providers add` wrote into `~/.fragua/fragua.db`. This is what makes local
 * `fragua ci` "just work": without it, ci sees only env vars and ignores the
 * creds you already configured.
 *
 * It RESOLVES each provider's token against the global store and seeds `target`
 * with the bare token as an `api_key` — it does NOT copy raw credential rows.
 * That distinction is load-bearing for OAuth: refreshing an OAuth token ROTATES
 * the refresh token. If we copied the OAuth row into the ephemeral ci store and
 * it refreshed there, the rotated token would land in the ephemeral store (and
 * vanish with the temp dir) while the global store kept the now-dead one —
 * silently breaking the daemon's creds. Resolving here means any refresh happens
 * IN the global store (rotation persists where the daemon reads it), under the
 * same per-row lock the daemon uses; the ephemeral store only ever holds an
 * immutable bare token that can't rotate anything. Custom-provider definitions
 * (`provider_config`) are copied as-is — they carry no rotating secret.
 *
 * A no-op when there's no global store (a fresh CI machine), so ci falls back to
 * env-only there. Layer `seedCredsFromEnv` AFTER this so an env/CI secret
 * overrides a configured provider (env wins). Returns the providers seeded,
 * plus one `mcp:<url>` entry per MCP login copied.
 */
export async function seedCredsFromGlobalStore(
  target: SqliteStore,
  targetPath: string,
  globalPath: string = resolve(getFraguaHome(), "fragua.db"),
): Promise<string[]> {
  // No global store (CI), or ci was pointed AT the global store (--db) so the
  // creds are already present — nothing to copy.
  if (!existsSync(globalPath) || resolve(targetPath) === resolve(globalPath)) return [];
  const source = new SqliteStore({ path: globalPath, migrate: false });
  try {
    const from = AuthStorage.fromStore(source);
    const to = AuthStorage.fromStore(target);
    const seeded: string[] = [];
    for (const provider of from.list()) {
      // Resolves an api_key verbatim, or an OAuth access token (refreshing in
      // the GLOBAL store when expired — see the rotation note above).
      const key = await from.getApiKey(provider);
      if (!key || key === "<authenticated>") continue;
      to.set(provider, { type: "api_key", key });
      seeded.push(provider);
    }
    // Remote MCP logins ride along the same way: the access token only, never
    // the refresh token (see the rotation note above), skipped when expired.
    // Without this an `mcp-servers:` step against an OAuth server reads as
    // "not logged in" under ci, however many times the operator logged in.
    const now = Date.now();
    for (const row of source.listMcpOAuth()) {
      const blob = portableOAuthBlob(row.payload, now);
      if (blob === undefined) continue;
      target.upsertMcpOAuth(row.url, blob);
      seeded.push(`mcp:${row.url}`);
    }
    // Custom-provider definitions (Ollama / vLLM / proxies) live in
    // provider_config, separate from the credential rows. listProviderConfigs
    // returns parsed JSON; upsert wants a serialised string (I1 — the
    // stringify happens here, outside any write txn), so re-encode.
    for (const row of source.listProviderConfigs()) {
      target.upsertProviderConfig({ provider: row.provider, config: JSON.stringify(row.config) });
    }
    return seeded;
  } finally {
    source.close();
  }
}
