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
import { type IProviderCredentialStore, SqliteStore } from "@fragua/store";
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
 */
const ALWAYS_PROVIDER_CRED: ReadonlySet<string> = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]);

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
 *     prefix scan in {@link daemonEnvDeny}.
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
 * also checks the value is non-empty) and `ciEnvDenyNames` (strip by
 * name unconditionally — an attacker could set the var later). */
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

/**
 * Build the set of env var NAMES that should be stripped from bash-tool
 * subprocesses in `fragua ci` (perimeter env-strip).
 *
 * Uses the same predicate as `captureCiEnvSecrets` so the strip set ≡ the
 * scrub-needle name set ("one list, two consumers"). Unlike `captureCiEnvSecrets`,
 * empty-value vars ARE included — the strip is name-based, unconditional,
 * because an attacker could later assign a value to a secret-named var.
 *
 * `allow` names (from `fragua ci --allow-env`) are exempted from the strip so a
 * workflow's deterministic tool steps can reach them (e.g. `gh` needs GH_TOKEN).
 * This affects ONLY the strip — an allowed var is NOT removed from the tool
 * subprocess env, but it is STILL captured as a scrub needle (`captureCiEnvSecrets`
 * is deliberately unaffected), so its value is redacted from the exported bundle.
 * Allow ≠ declassify. Provider-credential names must NEVER be allowed through —
 * guard with {@link unsafeAllowEnvNames} at the call site before passing them here.
 *
 * @param env - defaults to `process.env`; injectable for tests.
 * @param allow - names kept OUT of the deny set so they reach tool steps; still
 *   scrubbed from the exported bundle. Default: none.
 */
export function ciEnvDenyNames(
  env: NodeJS.ProcessEnv = process.env,
  allow: ReadonlySet<string> = NO_ALLOW,
  ctx: ProviderCredentialContext = buildProviderCredentialContext(),
): Set<string> {
  const result = new Set<string>();
  for (const name of Object.keys(env)) {
    if (allow.has(name)) continue;
    if (isSecretEnvName(name, ctx)) result.add(name);
  }
  return result;
}

/**
 * Returns a PREDICATE `(name: string) => boolean` that returns `true` when an
 * env var name should be stripped from a bash subprocess. Uses the same rule
 * as `ciEnvDenyNames` / `captureCiEnvSecrets` (`isSecretEnvName`) so strip
 * and needle-set share one definition.
 *
 * Unlike `ciEnvDenyNames` (a Set captured at call time), this predicate is
 * applied at SPAWN TIME against the live env, catching any secret-named var
 * set AFTER the Set was built. The provider-var set is memoised in the closure
 * so the predicate is cheap to call on every spawn.
 *
 * @param allow - names kept OUT of the strip so they reach tool steps; still
 *   scrubbed from the exported bundle (allow ≠ declassify). Default: none. See
 *   {@link ciEnvDenyNames} — provider creds must never be allowed through.
 */
export function ciEnvDenyPredicate(
  allow: ReadonlySet<string> = NO_ALLOW,
  ctx: ProviderCredentialContext = buildProviderCredentialContext(),
): (name: string) => boolean {
  return (name: string) => !allow.has(name) && isSecretEnvName(name, ctx);
}

/** Shared empty allow-set so the default path allocates nothing. */
const NO_ALLOW: ReadonlySet<string> = new Set();

/**
 * Build the env-strip for `fragua daemon` (hence the harness). Reuses the same
 * secret-name rule as `fragua ci` — no separate list — so a workflow's bash
 * steps never inherit the operator's provider credentials.
 *
 * Returns a `names` set (captured against the passed env) AND a spawn-time
 * `predicate` (catches secret-named vars set after capture). Both mirror the
 * ci pair (`ciEnvDenyNames` / `ciEnvDenyPredicate`).
 *
 * `storeProviders` adds the pi-ai env-var names of every provider the daemon
 * holds credentials for in its store — belt over the predicate, whose
 * provider-var set is registration-gated and can be empty early. `passthrough`
 * (from `bash.env-passthrough`) re-admits named vars; it never re-admits a
 * provider credential — those are refused via {@link isProviderCredential} and
 * stripped regardless of passthrough, matching the ci `unsafeAllowEnvNames` rail.
 *
 * Returns the EFFECTIVE `passthrough` (post-refusal) so callers log the set that
 * actually took effect, not the requested one. Refused names are `console.warn`ed
 * once, pointing at `fragua providers` as the right place to hold a credential.
 */
export function daemonEnvDeny(
  opts: {
    env?: NodeJS.ProcessEnv;
    storeProviders?: Iterable<string>;
    passthrough?: ReadonlySet<string>;
    ctx?: ProviderCredentialContext;
    /** Emit a `console.warn` naming refused passthrough entries. Default true.
     * The daemon sets `false` and surfaces refusals ONCE in its startup log
     * instead of on every per-run provision. */
    warn?: boolean;
  } = {},
): { names: Set<string>; predicate: (name: string) => boolean; passthrough: ReadonlySet<string> } {
  const env = opts.env ?? process.env;
  const requested = opts.passthrough ?? NO_ALLOW;
  const ctx = opts.ctx ?? buildProviderCredentialContext();
  const providers = [...(opts.storeProviders ?? [])];
  const storeProviderPrefixes = buildStoreProviderPrefixes(providers);
  // Refuse provider credentials in the passthrough — same rail as ci's
  // `--allow-env` (`unsafeAllowEnvNames`). A workflow may re-admit generic
  // secrets (GH_TOKEN, …) but never an LLM-provider key fragua reads directly.
  // Fold the storeProviders prefix scan into the SAME filter as gate-4's
  // exact-prefix match: a `<HELD-PREFIX>_<WORD>_<SECRET-SUFFIX>` var (which
  // gate 4 cannot classify) is refused up front, so it never lingers in the
  // effective passthrough — the one place `names` and `predicate` could
  // otherwise disagree on the same input.
  const refused = new Set([...requested].filter((n) => isDeniedEnvName(n, ctx, storeProviderPrefixes)));
  const passthrough: ReadonlySet<string> =
    refused.size === 0 ? requested : new Set([...requested].filter((n) => !refused.has(n)));
  if (refused.size > 0 && (opts.warn ?? true)) {
    console.warn(
      `fragua: refusing to pass provider credential(s) through bash.env-passthrough: ${JSON.stringify([...refused])} — ` +
        `hold provider credentials with \`fragua providers\`, not env-passthrough`,
    );
  }
  const names = ciEnvDenyNames(env, passthrough, ctx);
  const envNames = Object.keys(env);
  for (const provider of providers) {
    // A held provider's credential is stripped regardless of passthrough — same
    // rail as the refusal filter above. `storeProviders` holds provider NAMES
    // (from `authStorage.list()`), including custom store-only providers pi-ai's
    // static registry can't name. For each we synthesise the conventional
    // `<PREFIX>_API_KEY` (covers a cred absent from this process's env), add any
    // env-var pi-ai maps to the provider, and — crucially for custom providers
    // — every secret-shaped env var carrying this provider's prefix (e.g.
    // `CUSTOMAI_OAUTH_TOKEN`, which gate 4's exact-prefix match cannot catch).
    const prefix = providerEnvPrefix(provider);
    const candidates = new Set<string>([`${prefix}_API_KEY`]);
    try {
      for (const n of findEnvKeys(provider) ?? []) candidates.add(n);
    } catch {
      // Unknown/custom provider — pi-ai has no env-var mapping. The synthetic
      // and prefix-scanned names below still cover it. A throw must not crash startup.
    }
    for (const envName of envNames) {
      if (envName.toUpperCase().startsWith(`${prefix}_`) && isSecretEnvName(envName, ctx)) {
        candidates.add(envName);
      }
    }
    for (const name of candidates) {
      if (COPILOT_AMBIENT_ENV.has(name)) continue;
      names.add(name);
    }
  }
  return { names, predicate: ciEnvDenyPredicate(passthrough, ctx), passthrough };
}

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
 * {@link daemonEnvDeny} uses, so the CI `--allow-env` rail and the daemon deny
 * surface agree on which names are provider credentials.
 */
export function unsafeAllowEnvNames(allow: Iterable<string>, storeProviders: Iterable<string> = []): string[] {
  const ctx = buildProviderCredentialContext();
  const storeProviderPrefixes = buildStoreProviderPrefixes(storeProviders);
  const bad: string[] = [];
  for (const name of allow) {
    // Shared with `daemonEnvDeny`'s refusal filter via `isDeniedEnvName`. The
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
 * overrides a configured provider (env wins). Returns the providers seeded.
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
