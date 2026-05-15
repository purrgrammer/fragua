// `swarm providers …` — inspect, credential, test, and OAuth-login
// LLM providers.
//
// Credentials and custom-provider definitions both live in the global
// swarm store (`~/.swarm/swarm.db`) under `provider_credentials` and
// `provider_config` respectively. Each command opens the global store
// briefly and closes it before returning.

export { providersAddCustomCommand } from "./providers-custom.ts";

import type { OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { AuthStorage, defaultModelPerProvider, getSwarmHome, ModelRegistry } from "@swarm/agent";
import chalk from "chalk";
import prompts from "prompts";
import { openGlobalStore } from "./open-global-store.ts";

// ---------------------------------------------------------------------------
// help + ls
// ---------------------------------------------------------------------------

export function providersHelpCommand(): number {
  console.log(chalk.bold("swarm providers — manage LLM provider credentials + custom models\n"));
  console.log("Subcommands:");
  console.log(`  ${chalk.cyan("ls")}                       List all providers + credentialed status`);
  console.log(`  ${chalk.cyan("add [provider]")}           Add API-key credentials interactively`);
  console.log(
    `  ${chalk.cyan("add --custom")}             Add a custom (OpenAI-compatible) provider to the global store`,
  );
  console.log(`  ${chalk.cyan("rm <provider>")}            Remove stored credentials`);
  console.log(`  ${chalk.cyan("test <provider> [model]")}  Stream a 1-token call to verify the setup`);
  console.log(`  ${chalk.cyan("login [provider]")}         Run the OAuth flow for a subscription-based provider`);
  console.log(`  ${chalk.cyan("logout <provider>")}        Clear stored OAuth tokens`);
  console.log();
  console.log(chalk.dim("Credentials live in ~/.swarm/swarm.db (provider_credentials table)."));
  console.log(chalk.dim("Custom providers + model overrides live in ~/.swarm/swarm.db (provider_config table)."));
  return 0;
}

export function providersListCommand(): number {
  const store = openGlobalStore();
  try {
    const auth = AuthStorage.fromStore(store);
    const registry = ModelRegistry.create(auth, store);

    const byProvider = new Map<string, number>();
    for (const m of registry.getAll()) {
      byProvider.set(m.provider, (byProvider.get(m.provider) ?? 0) + 1);
    }

    if (byProvider.size === 0) {
      console.log(chalk.dim("no providers registered — unexpected; pi-ai should bundle built-ins"));
      return 0;
    }

    console.log(chalk.bold("Providers (via pi-ai registry):\n"));
    const rows = [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let credentialed = 0;
    for (const [name, count] of rows) {
      const ready = auth.hasAuth(name);
      if (ready) credentialed++;
      const source = ready ? auth.describeAuthSource(name) : null;
      const mark = ready ? chalk.green("✓") : chalk.dim("·");
      const nameCol = name.padEnd(24);
      const countCol = `${count} model${count === 1 ? "" : "s"}`.padEnd(12);
      const sourceCol = source ? ` ${source}` : "";
      console.log(`${mark} ${nameCol}${chalk.dim(countCol)}${chalk.dim(sourceCol)}`);
    }
    const err = registry.getError();
    if (err) {
      console.log();
      console.log(chalk.yellow(`provider_config: ${err}`));
    }
    console.log(chalk.dim(`\n${credentialed}/${rows.length} providers credentialed`));
    console.log(chalk.dim(`swarm home: ${getSwarmHome()}`));
    console.log(chalk.dim("run `swarm providers add <provider>` to configure one, or `login <provider>` for OAuth"));
    return 0;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// rm + logout
// ---------------------------------------------------------------------------

export async function providersRmCommand(provider: string | undefined): Promise<number> {
  if (!provider) {
    console.error(chalk.red("usage: swarm providers rm <provider>"));
    return 1;
  }
  const store = openGlobalStore();
  try {
    const auth = AuthStorage.fromStore(store);
    if (!auth.has(provider)) {
      console.log(chalk.dim(`no credentials stored for "${provider}"`));
      return 0;
    }
    const { confirm } = await prompts({
      type: "confirm",
      name: "confirm",
      message: `Remove stored credentials for "${provider}"?`,
      initial: false,
    });
    if (!confirm) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }
    auth.remove(provider);
    // Symmetric cleanup: a custom provider has both a credentials row
    // (this one we just removed) and a `provider_config` row. The two
    // tables don't share a foreign key, so the cleanup is sequential
    // — each write is its own short txn; the resulting state ends up
    // consistent for the operator's mental model (rm = both gone).
    store.deleteProviderConfig(provider);
    console.log(chalk.green(`✓ removed credentials for "${provider}"`));
    return 0;
  } finally {
    store.close();
  }
}

export async function providersLogoutCommand(provider: string | undefined): Promise<number> {
  if (!provider) {
    console.error(chalk.red("usage: swarm providers logout <provider>"));
    return 1;
  }
  const store = openGlobalStore();
  try {
    const auth = AuthStorage.fromStore(store);
    const cred = auth.get(provider);
    if (!cred) {
      console.log(chalk.dim(`no credentials stored for "${provider}"`));
      return 0;
    }
    if (cred.type !== "oauth") {
      console.error(
        chalk.red(`"${provider}" is stored as ${cred.type}, not oauth — use \`swarm providers rm\` instead`),
      );
      return 1;
    }
    auth.logout(provider);
    console.log(chalk.green(`✓ logged out of "${provider}"`));
    return 0;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

export async function providersTestCommand(
  provider: string | undefined,
  modelOverride: string | undefined,
): Promise<number> {
  if (!provider) {
    console.error(chalk.red("usage: swarm providers test <provider> [model]"));
    return 1;
  }
  const store = openGlobalStore();
  try {
    const auth = AuthStorage.fromStore(store);
    const registry = ModelRegistry.create(auth, store);

    // Resolve model: explicit override > provider default > first available
    // for provider. Falling back to "any model of this provider" keeps the
    // test command useful for custom Ollama-style providers that aren't in
    // defaultModelPerProvider — but only when the user didn't specify one;
    // a requested-but-missing model is always a hard error.
    let model: ReturnType<ModelRegistry["find"]>;
    if (modelOverride) {
      model = registry.find(provider, modelOverride);
      if (!model) {
        console.error(chalk.red(`model "${provider}/${modelOverride}" not registered`));
        console.error(chalk.dim("  check `swarm providers ls` for the list of known providers"));
        return 1;
      }
    } else {
      const defaultId = defaultModelPerProvider[provider as keyof typeof defaultModelPerProvider];
      model = defaultId ? registry.find(provider, defaultId) : undefined;
      if (!model) model = registry.getAll().find((m) => m.provider === provider);
      if (!model) {
        console.error(chalk.red(`no models registered for provider "${provider}"`));
        console.error(chalk.dim("  check `swarm providers ls` for the list of known providers"));
        return 1;
      }
    }

    if (!auth.hasAuth(provider)) {
      console.error(chalk.red(`no credentials configured for "${provider}"`));
      console.error(
        chalk.dim(`  run \`swarm providers add ${provider}\`, or \`swarm providers login ${provider}\` for OAuth`),
      );
      return 1;
    }

    const apiKey = await auth.getApiKey(provider);
    if (!apiKey) {
      console.error(chalk.red(`credentials configured for "${provider}" but getApiKey returned nothing`));
      return 1;
    }
    const source = auth.describeAuthSource(provider) ?? "unknown";
    const keyPreview = `${apiKey.slice(0, 6)}…${apiKey.slice(-4)} (${apiKey.length} chars)`;

    console.log(chalk.dim(`testing ${provider}/${model.id} …`));
    console.log(chalk.dim(`  source: ${source}`));
    console.log(chalk.dim(`  key:    ${keyPreview}`));
    const started = Date.now();
    let firstDeltaMs: number | undefined;
    let outputTokens = 0;
    try {
      const stream = streamSimple(
        model,
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools: [] },
        // biome-ignore lint/suspicious/noExplicitAny: pi-ai accepts provider-specific options as an opaque bag.
        { maxTokens: 1, apiKey } as any,
      );
      for await (const ev of stream) {
        if (ev.type === "text_delta" && firstDeltaMs === undefined) firstDeltaMs = Date.now() - started;
        if (ev.type === "done") outputTokens = ev.message.usage?.output ?? 0;
        if (ev.type === "error") {
          const msg = ev.error.errorMessage ?? "unknown provider error";
          console.error(chalk.red(`✗ ${msg}`));
          return 1;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`✗ ${msg}`));
      return 1;
    }

    const total = Date.now() - started;
    const firstLabel =
      firstDeltaMs !== undefined
        ? `${firstDeltaMs}ms to first token`
        : `no text tokens (model emitted ${outputTokens} output tokens)`;
    console.log(chalk.green(`✓ ${provider}/${model.id} responded — ${firstLabel}, ${total}ms total`));
    return 0;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// add (api_key)
// ---------------------------------------------------------------------------

export async function providersAddCommand(providerArg: string | undefined): Promise<number> {
  const store = openGlobalStore();
  let chosenProvider: string | undefined;
  try {
    const auth = AuthStorage.fromStore(store);
    const registry = ModelRegistry.create(auth, store);

    const knownProviders = [...new Set(registry.getAll().map((m) => m.provider))].sort();

    let provider = providerArg;
    if (!provider) {
      const res = await prompts({
        type: "autocomplete",
        name: "provider",
        message: "Provider",
        choices: knownProviders.map((p) => ({ title: p, value: p })),
      });
      provider = res.provider;
    }
    if (!provider) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }
    if (!knownProviders.includes(provider)) {
      console.log(
        chalk.yellow(
          `"${provider}" is not a pi-ai built-in — add it as a custom provider via \`swarm providers add --custom\` if you want models under it`,
        ),
      );
    }

    if (auth.has(provider)) {
      const existing = auth.get(provider);
      const { overwrite } = await prompts({
        type: "confirm",
        name: "overwrite",
        message: `credentials already stored for "${provider}" (${existing?.type}) — overwrite?`,
        initial: false,
      });
      if (!overwrite) {
        console.log(chalk.dim("cancelled"));
        return 0;
      }
    }

    // Keys are stored verbatim in the global store
    // (`provider_credentials` table). Single password prompt for the
    // key.
    const res = await prompts({ type: "password", name: "value", message: `Paste the API key for ${provider}` });
    const keyField: string | undefined = res.value;
    if (!keyField) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }

    auth.set(provider, { type: "api_key", key: keyField });
    console.log(chalk.green(`✓ stored credentials for "${provider}" in ${getSwarmHome()}/swarm.db`));
    chosenProvider = provider;
  } finally {
    store.close();
  }

  // `providersTestCommand` reopens the store on its own. Closing first
  // avoids holding two write handles to the same DB across the
  // streamed test call.
  const { runTest } = await prompts({
    type: "confirm",
    name: "runTest",
    message: "Test now with a 1-token call?",
    initial: true,
  });
  if (runTest && chosenProvider) return providersTestCommand(chosenProvider, undefined);
  return 0;
}

// ---------------------------------------------------------------------------
// login (oauth)
// ---------------------------------------------------------------------------

export async function providersLoginCommand(providerArg: string | undefined): Promise<number> {
  const store = openGlobalStore();
  try {
    const auth = AuthStorage.fromStore(store);
    const oauthProviders = auth.getOAuthProviders();
    if (oauthProviders.length === 0) {
      console.error(chalk.red("no OAuth providers registered in pi-ai"));
      return 1;
    }

    let provider = providerArg;
    if (!provider) {
      const res = await prompts({
        type: "select",
        name: "provider",
        message: "OAuth provider",
        choices: oauthProviders.map((p) => ({ title: `${p.name} (${p.id})`, value: p.id })),
      });
      provider = res.provider;
    }
    if (!provider) {
      console.log(chalk.dim("cancelled"));
      return 0;
    }
    const oauth = oauthProviders.find((p) => p.id === provider);
    if (!oauth) {
      console.error(chalk.red(`"${provider}" is not a registered OAuth provider`));
      console.error(chalk.dim(`  available: ${oauthProviders.map((p) => p.id).join(", ")}`));
      return 1;
    }

    if (auth.has(provider)) {
      const existing = auth.get(provider);
      const { overwrite } = await prompts({
        type: "confirm",
        name: "overwrite",
        message: `credentials already stored for "${provider}" (${existing?.type}) — re-login?`,
        initial: false,
      });
      if (!overwrite) {
        console.log(chalk.dim("cancelled"));
        return 0;
      }
    }

    const callbacks: OAuthLoginCallbacks = {
      onAuth: (info) => {
        console.log(chalk.bold(`\nOpen this URL to authenticate:\n  ${info.url}\n`));
        if (info.instructions) console.log(chalk.dim(info.instructions));
      },
      onPrompt: async (p) => {
        const res = await prompts({
          type: "text",
          name: "value",
          message: p.message,
          ...(p.placeholder ? { initial: p.placeholder } : {}),
          validate: (v: string) => (p.allowEmpty || v.length > 0 ? true : "must not be empty"),
        });
        return typeof res.value === "string" ? res.value : "";
      },
      onProgress: (message) => {
        console.log(chalk.dim(`  ${message}`));
      },
      onManualCodeInput: async () => {
        const res = await prompts({ type: "text", name: "value", message: "Paste the authorization code" });
        return typeof res.value === "string" ? res.value : "";
      },
    };

    try {
      await auth.login(provider, callbacks);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`✗ OAuth login failed: ${msg}`));
      return 1;
    }
    console.log(chalk.green(`✓ logged in to "${provider}"`));
    return 0;
  } finally {
    store.close();
  }
}
