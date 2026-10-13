// Minimal stdio MCP server used by connector.test.ts. Exposes a single `echo`
// tool with a raw JSON-Schema inputSchema (no zod) so the test exercises the
// plain-JSON-Schema passthrough. Run as: `<bun> echo-server.ts`.
// With FRAGUA_MCP_SPAWN_LOG set (via the server's mcp.json `env`), each start
// appends its pid to that file so a test can count spawns; `__exit__` kills it.

import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const spawnLog = process.env["FRAGUA_MCP_SPAWN_LOG"];
if (spawnLog) appendFileSync(spawnLog, `${process.pid}\n`);

const server = new Server({ name: "echo", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echoes the provided text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = String((req.params.arguments as { text?: unknown } | undefined)?.text ?? "");
  if (text === "__error__") {
    return { content: [{ type: "text", text: "boom" }], isError: true };
  }
  if (text === "__exit__") process.exit(1);
  if (text === "__hang__") {
    // Never respond — the client's call timeout must fire.
    await new Promise(() => {});
  }
  return { content: [{ type: "text", text: `echo: ${text}` }] };
});

await server.connect(new StdioServerTransport());
