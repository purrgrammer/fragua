// Minimal stdio MCP server that returns its tools in deliberately
// NON-alphabetical order. Servers choose their own `tools/list` order and
// may change it between versions; tool definitions lead the provider's
// prompt-cache prefix, so the connector must impose its own order rather
// than trusting this one. Run as: `<bun> unsorted-server.ts`.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "unsorted", version: "0.0.1" }, { capabilities: { tools: {} } });

const TOOL_NAMES = ["zebra", "apple", "mango", "banana"];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_NAMES.map((name) => ({
    name,
    description: `Returns ${name}.`,
    inputSchema: { type: "object", properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: String(req.params.name) }],
}));

await server.connect(new StdioServerTransport());
