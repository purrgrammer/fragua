// A stdio MCP server exposing two tools whose names slug to the same fragua
// name (`a.b` and `a-b` → `mcp__collide__a_b`). Exercises the collision guard.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "collide", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "a.b", description: "first", inputSchema: { type: "object" } },
    { name: "a-b", description: "second (collides)", inputSchema: { type: "object" } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "ok" }] }));

await server.connect(new StdioServerTransport());
