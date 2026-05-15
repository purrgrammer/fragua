// Barrel for the credentials layer. pi-coding-agent–derived (MIT);
// see individual files for attribution headers.

export * from "./auth-storage.ts";
export * from "./model-registry.ts";
export * from "./model-resolver.ts";
export * from "./paths.ts";
// resolve-config-value is kept while ModelRegistry consumes it for the
// `models.json` custom-provider `apiKey` field; the follow-up
// provider-config-storage proposal deletes the file entirely.
export {
  resolveConfigValue,
  resolveConfigValueOrThrow,
  resolveConfigValueUncached,
  resolveHeaders,
  resolveHeadersOrThrow,
} from "./resolve-config-value.ts";
