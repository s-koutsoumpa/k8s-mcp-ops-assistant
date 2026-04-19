// =============================================================================
// index.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This is the entry point of the whole application — the first file that runs
// when you start the server with `npm start` or `node dist/index.js`.
//
// It creates an Express HTTP server and exposes one main endpoint: POST /mcp.
// That endpoint is how n8n (the workflow automation tool) talks to this
// Kubernetes assistant using the MCP (Model Context Protocol) standard.
//
// WHERE IS IT USED?
// -----------------
// This file is NOT imported by anything else. It IS the program.
// When you run `npm start`, Node.js runs this file directly.
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// The file is deliberately thin. All the actual Kubernetes tools and logic
// live in server.ts (which registers tools) and the files under src/tools/
// and src/analysis/. This file's only job is to:
//   1. Accept HTTP requests from n8n
//   2. Route them into the MCP server (created in server.ts)
//   3. Send back whatever the MCP server returns
//
// MCP SESSION LIFECYCLE:
// ----------------------
// MCP uses "sessions" (like a logged-in user session). Each session gets a
// unique ID. We keep one transport object per session in the `transports` map
// and one server object in the `servers` map, so messages from the same
// session always go to the same server instance.
// =============================================================================

// We use Express to handle incoming HTTP requests.
// `require()` is used here instead of `import` because the MCP SDK packages
// use CommonJS modules, so we mix the two styles in this file only.
const express = require("express");
const { randomUUID } = require("node:crypto");

// StreamableHTTPServerTransport is the MCP-standard way to send/receive
// messages over plain HTTP (as opposed to WebSockets or stdio).
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

// isInitializeRequest checks if an incoming JSON body is the special
// "initialize" message that every new MCP session must start with.
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");

// createMcpServer is our function that registers all the Kubernetes tools
// (list_deployments, analyze_deployment, execute_action, etc.).
const { createMcpServer } = require("./server");

// Create the Express app and tell it to parse JSON request bodies
// so we can read req.body in our route handlers.
const app = express();
app.use(express.json());

// We keep one transport and one server per active MCP session.
// The session ID (a UUID) is the key; the transport/server objects are the values.
const transports: Record<string, any> = {};
const servers: Record<string, any> = {};


// =============================================================================
// GET /health
// =============================================================================
//
// WHAT IT DOES:
//   Returns a simple { ok: true } response so that monitoring tools (like
//   Kubernetes liveness probes or uptime monitors) can check if the server
//   is alive without touching any Kubernetes logic.
//
// WHEN TO USE IT:
//   Hit this endpoint to verify the HTTP server is running.
//   It does not check whether Kubernetes is reachable.
// =============================================================================
app.get("/health", (_req: any, res: any) => {
  res.json({ ok: true });
});


// =============================================================================
// POST /mcp  — the main MCP endpoint
// =============================================================================
//
// WHAT IT DOES:
//   Handles all MCP requests from n8n. This is the only endpoint that n8n
//   actually sends tool calls to.
//
// WHEN TO USE IT:
//   n8n calls this automatically; you do not call it manually.
//
// HOW IT WORKS:
//   Every request either:
//   A) Has an "mcp-session-id" header → it belongs to an existing session.
//      We look up the transport for that session and forward the request.
//   B) Has no session ID → it must be a new session starting with "initialize".
//      We create a fresh MCP server + transport and store them.
// =============================================================================
app.post("/mcp", async (req: any, res: any) => {
  try {
    // STEP 1: Check if this request belongs to an existing session.
    // The "as string | undefined" cast tells TypeScript what type to expect.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Look up existing transport and server for this session (may be undefined).
    let transport = sessionId ? transports[sessionId] : undefined;
    let server = sessionId ? servers[sessionId] : undefined;

    // STEP 2: If no transport exists, we need to start a new session.
    if (!transport) {

      // If a session ID was provided but we don't recognize it, that's an error.
      // (The client is claiming to continue a session that doesn't exist.)
      if (sessionId) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Invalid session ID" },
          id: null,
        });
        return;
      }

      // A brand-new session must start with an MCP "initialize" message.
      // If this is anything else, reject it.
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Missing initialize request" },
          id: null,
        });
        return;
      }

      // STEP 3: Create a fresh MCP server (with all tools registered).
      server = createMcpServer();

      // STEP 4: Create a transport that will carry messages over HTTP.
      // sessionIdGenerator creates a new UUID for each new session.
      // onsessioninitialized saves both the transport and server so future
      // requests from the same session can find them.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId: string) => {
          transports[newSessionId] = transport;
          servers[newSessionId] = server;
        },
      });

      // STEP 5: Clean up when the session closes.
      // If n8n disconnects, we remove the session from our maps so memory
      // doesn't grow forever.
      transport.onclose = async () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
          delete servers[transport.sessionId];
        }
      };

      // STEP 6: Wire the server to the transport so they can talk to each other.
      await server.connect(transport);
    }

    // STEP 7: Forward the HTTP request to the MCP transport for processing.
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


// =============================================================================
// handleSessionRequest  (shared by GET /mcp and DELETE /mcp)
// =============================================================================
//
// WHAT IT DOES:
//   Handles GET and DELETE requests to /mcp. These are used by the MCP
//   protocol for SSE (Server-Sent Events) streaming and session cleanup.
//   They both need to find an existing session by ID, so the logic is shared.
//
// WHEN TO USE IT:
//   Called automatically by Express when n8n sends a GET or DELETE to /mcp.
//   You do not call this function directly.
//
// HOW IT WORKS:
//   STEP 1: Read the session ID from the request headers.
//   STEP 2: Look up the transport for that session.
//   STEP 3: Forward the request to the transport.
// =============================================================================
async function handleSessionRequest(req: any, res: any) {
  try {
    // STEP 1: Read the session ID header. If missing, reject the request.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    // STEP 2: Find the transport that owns this session.
    const transport = transports[sessionId];

    // STEP 3: Forward the request to the transport (it handles the rest).
    await transport.handleRequest(req, res);

  } catch (error: any) {
    console.error("Session request error:", error);
    res.status(500).send(error?.message || "Internal server error");
  }
}

// Register handleSessionRequest for both GET and DELETE on /mcp.
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);


// =============================================================================
// Start the HTTP server
// =============================================================================
//
// We bind to 0.0.0.0 (all network interfaces) so the server is reachable
// from both localhost and the VM's external IP. n8n needs to reach it over
// the network, so binding to 127.0.0.1 alone would not work.
// =============================================================================
const PORT = 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP HTTP server running on http://0.0.0.0:${PORT}/mcp`);
});
