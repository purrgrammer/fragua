// In-process Streamable-HTTP MCP endpoint on 127.0.0.1 for connector.test.ts.
// Answers JSON-RPC over plain `application/json` (no SSE, GET → 405) and records
// the `Authorization` header of every request plus the number of `initialize`
// handshakes, so a test can prove a pooled connection re-reads a rotated OAuth
// token without re-handshaking.

export interface HttpAuthServer {
  url: string;
  authHeaders: string[];
  initializeCount(): number;
  stop(): void;
}

export function startHttpAuthServer(): HttpAuthServer {
  const authHeaders: string[] = [];
  let initializes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (req.method === "GET") return new Response(null, { status: 405 });
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      authHeaders.push(req.headers.get("authorization") ?? "");
      const msg = (await req.json()) as { id?: number | string; method: string; params?: Record<string, unknown> };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) =>
        Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers: { "mcp-session-id": "pooled-session" } });
      switch (msg.method) {
        case "initialize":
          initializes += 1;
          return reply({
            protocolVersion: msg.params?.["protocolVersion"],
            capabilities: { tools: {} },
            serverInfo: { name: "http-auth", version: "0.0.1" },
          });
        case "tools/list":
          return reply({
            tools: [{ name: "whoami", description: "Echoes the bearer.", inputSchema: { type: "object" } }],
          });
        case "tools/call":
          return reply({ content: [{ type: "text", text: req.headers.get("authorization") ?? "" }] });
        default:
          return reply({});
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    authHeaders,
    initializeCount: () => initializes,
    stop: () => server.stop(true),
  };
}
