// Stdio MCP server used by connector.test.ts to prove the env allowlist. Exposes
// a `getenv` tool that returns the value of the requested environment variable
// (empty string when absent), so a test can assert a daemon secret did NOT leak
// into the child while PATH / server.env did. Also exposes a `rich` tool that
// returns a non-text content block, to exercise `toLlmContent` rendering.
// Run as: `<bun> env-server.ts`.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "env", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "getenv",
      description: "Returns the value of an environment variable.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    {
      name: "rich",
      description: "Returns a non-text content block.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "rich") {
    return {
      content: [
        { type: "text", text: "intro" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      ],
    };
  }
  const name = String((req.params.arguments as { name?: unknown } | undefined)?.name ?? "");
  return { content: [{ type: "text", text: process.env[name] ?? "" }] };
});

await server.connect(new StdioServerTransport());
