// A stdio MCP server that completes `initialize` (so client.connect succeeds)
// but errors on `tools/list`. Used to exercise the connector's post-connect
// failure path — the client must be closed rather than left orphaned.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "bad-list", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  throw new Error("tools/list is broken");
});

await server.connect(new StdioServerTransport());
