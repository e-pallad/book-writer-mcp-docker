import * as http from "http";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server";
import { getProjectPaths } from "./storage/filestore";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
const DEFAULT_PORT = 3456;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const port = Number(process.env.PORT) || DEFAULT_PORT;
const host = process.env.HOST || "0.0.0.0";
const authToken = process.env.MCP_AUTH_TOKEN;

// One transport per MCP session, keyed by the session id issued on initialize.
const transports: Record<string, StreamableHTTPServerTransport> = {};

function sendJSON(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string
): void {
  sendJSON(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

// Compares hashes so the check runs in constant time regardless of token length.
function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;

  const provided = createHash("sha256").update(header.slice(7).trim()).digest();
  const expected = createHash("sha256").update(authToken as string).digest();
  return timingSafeEqual(provided, expected);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function createSession(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      transports[sessionId] = transport;
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) {
      delete transports[transport.sessionId];
    }
  };

  // Every session gets its own server instance built from the shared factory.
  await createServer().connect(transport);
  return transport;
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      sendError(res, 400, -32700, `Parse error: ${(error as Error).message}`);
      return;
    }

    let transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      if (sessionId) {
        sendError(res, 404, -32001, "Session not found");
        return;
      }
      if (!isInitializeRequest(body)) {
        sendError(res, 400, -32000, "Bad Request: no valid session ID provided");
        return;
      }
      transport = await createSession();
    }

    await transport.handleRequest(req, res, body);
    return;
  }

  // GET opens the notification stream, DELETE terminates the session.
  if (req.method === "GET" || req.method === "DELETE") {
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      sendError(res, 404, -32001, "Session not found");
      return;
    }
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(405, { Allow: "GET, POST, DELETE" });
  res.end();
}

const httpServer = http.createServer((req, res) => {
  const pathname = (req.url || "/").split("?")[0];

  if (pathname === HEALTH_PATH && req.method === "GET") {
    sendJSON(res, 200, {
      status: "ok",
      sessions: Object.keys(transports).length,
    });
    return;
  }

  if (pathname !== MCP_PATH) {
    sendError(res, 404, -32002, "Not found");
    return;
  }

  if (!isAuthorized(req)) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="book-writer-mcp"');
    sendError(res, 401, -32001, "Unauthorized: a valid bearer token is required");
    return;
  }

  handleMcpRequest(req, res).catch((error) => {
    console.error("Error handling MCP request:", error);
    if (res.headersSent) {
      res.end();
    } else {
      sendError(res, 500, -32603, "Internal server error");
    }
  });
});

async function shutdown(): Promise<void> {
  for (const transport of Object.values(transports)) {
    await transport.close();
  }
  httpServer.close(() => process.exit(0));
}

function main() {
  if (!authToken) {
    console.error(
      "MCP_AUTH_TOKEN is not set. Refusing to start an unauthenticated HTTP server."
    );
    process.exit(1);
  }

  httpServer.listen(port, host, () => {
    console.error(
      `book-writer-mcp HTTP transport listening on http://${host}:${port}${MCP_PATH}`
    );
    console.error(`Book project directory: ${getProjectPaths().projectDir}`);
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
