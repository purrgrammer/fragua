// Store→port adapter for MCP OAuth state. @fragua/workspace's OAuth provider
// depends only on the `McpOAuthStore` port ({ load, save, clear }); this maps
// that port onto the store's `mcp_oauth` methods, keeping @fragua/workspace
// free of any @fragua/store dependency. Shared by the daemon connector wiring
// and (later) the `fragua mcp login` command.

import type { SqliteStore } from "@fragua/store";
import type { McpOAuthStore } from "@fragua/workspace";

export function makeMcpOAuthStore(store: SqliteStore): McpOAuthStore {
  return {
    load: (url) => store.getMcpOAuth(url),
    save: (url, payload) => store.upsertMcpOAuth(url, payload),
    clear: (url) => store.deleteMcpOAuth(url),
  };
}
