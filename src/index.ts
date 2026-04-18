// We use Express to expose a normal HTTP endpoint.
// n8n will connect to this endpoint as an MCP server.

const express = require("express");
const { randomUUID } = require("node:crypto");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const { createMcpServer } = require("./server");

const app = express();
app.use(express.json());

// We keep one transport per MCP session.
// This is needed for the streamable HTTP MCP transport.
const transports: Record<string, any> = {};
const servers: Record<string, any> = {};

app.get("/health", (_req: any, res: any) => {
  res.json({ ok: true });
});

app.post("/mcp", async (req: any, res: any) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport = sessionId ? transports[sessionId] : undefined;
    let server = sessionId ? servers[sessionId] : undefined;

    // If there is no existing transport, a new session must start with initialize.
    if (!transport) {
      if (sessionId) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Invalid session ID",
          },
          id: null,
        });
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Missing initialize request",
          },
          id: null,
        });
        return;
      }

      server = createMcpServer();

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string) => {
          transports[newSessionId] = transport;
          servers[newSessionId] = server;
        },
      });

      transport.onclose = async () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          delete servers[transport.sessionId];
        }
      };

      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error: any) {
    console.error("POST /mcp error:", error);
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Internal server error",
        data: error?.message || String(error),
      },
      id: null,
    });
  }
});

async function handleSessionRequest(req: any, res: any) {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error: any) {
    console.error("Session request error:", error);
    res.status(500).send(error?.message || "Internal server error");
  }
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const PORT = 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP HTTP server running on http://0.0.0.0:${PORT}/mcp`);
});