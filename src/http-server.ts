import express, { NextFunction, Request, Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createServer } from "./server";
import { getProjectPaths } from "./storage/filestore";
import { OAuthStore } from "./auth/store";
import { BookOAuthProvider, CONSENT_PATH } from "./auth/provider";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
const DEFAULT_PORT = 3456;
const MAX_BODY_BYTES = "4mb";

const port = Number(process.env.PORT) || DEFAULT_PORT;
const host = process.env.HOST || "0.0.0.0";
const authToken = process.env.MCP_AUTH_TOKEN;
const publicUrl = process.env.MCP_PUBLIC_URL;
const oauthPassphrase = process.env.MCP_OAUTH_PASSPHRASE || authToken;

// One transport per MCP session, keyed by the session id issued on initialize.
const transports: Record<string, StreamableHTTPServerTransport> = {};

function sendError(
  res: Response,
  status: number,
  code: number,
  message: string
): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

// Compares hashes so the check runs in constant time regardless of token length.
function hasValidStaticToken(req: Request): boolean {
  if (!authToken) return false;
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;

  const provided = createHash("sha256").update(header.slice(7).trim()).digest();
  const expected = createHash("sha256").update(authToken).digest();
  return timingSafeEqual(provided, expected);
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

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST") {
    let transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      if (sessionId) {
        sendError(res, 404, -32001, "Session not found");
        return;
      }
      if (!isInitializeRequest(req.body)) {
        sendError(res, 400, -32000, "Bad Request: no valid session ID provided");
        return;
      }
      transport = await createSession();
    }

    await transport.handleRequest(req, res, req.body);
    return;
  }

  // GET opens the notification stream, DELETE terminates the session.
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    sendError(res, 404, -32001, "Session not found");
    return;
  }
  await transport.handleRequest(req, res);
}

function main() {
  if (!authToken) {
    console.error(
      "MCP_AUTH_TOKEN is not set. Refusing to start an unauthenticated HTTP server."
    );
    process.exit(1);
  }

  const app = express();
  app.disable("x-powered-by");

  const oauthEnabled = Boolean(publicUrl);
  let mcpAuth: (req: Request, res: Response, next: NextFunction) => void = (
    _req,
    _res,
    next
  ) => next();

  if (oauthEnabled) {
    const issuerUrl = new URL(publicUrl as string);
    if (issuerUrl.protocol !== "https:" && issuerUrl.hostname !== "localhost") {
      console.error(
        "MCP_PUBLIC_URL must use https (localhost excepted) for OAuth discovery to work."
      );
      process.exit(1);
    }

    const resourceUrl = new URL(MCP_PATH, issuerUrl);
    const store = new OAuthStore();
    store.pruneExpired();

    const provider = new BookOAuthProvider({
      store,
      passphrase: oauthPassphrase as string,
      resourceUrl: resourceUrl.href,
    });

    // The consent form is ours, so it is registered before the SDK router.
    app.post(
      CONSENT_PATH,
      express.urlencoded({ extended: false }),
      (req, res) => provider.handleConsent(req, res)
    );

    // Serves /authorize, /token, /register, /revoke and both metadata documents.
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl,
        resourceServerUrl: resourceUrl,
        resourceName: "Book Writer MCP",
        scopesSupported: ["mcp"],
      })
    );

    const bearerAuth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    });

    // Either auth path is accepted: the static token for clients that send a
    // header of their own, OAuth for connectors that run the full flow.
    mcpAuth = (req, res, next) => {
      if (hasValidStaticToken(req)) {
        next();
        return;
      }
      bearerAuth(req, res, next);
    };
  } else {
    mcpAuth = (req, res, next) => {
      if (hasValidStaticToken(req)) {
        next();
        return;
      }
      res.setHeader("WWW-Authenticate", 'Bearer realm="book-writer-mcp"');
      sendError(res, 401, -32001, "Unauthorized: a valid bearer token is required");
    };
  }

  app.get(HEALTH_PATH, (_req, res) => {
    res.json({
      status: "ok",
      sessions: Object.keys(transports).length,
      oauth: oauthEnabled,
    });
  });

  app.all(
    MCP_PATH,
    mcpAuth,
    express.json({ limit: MAX_BODY_BYTES }),
    (req, res, next) => {
      if (!["GET", "POST", "DELETE"].includes(req.method)) {
        res.set("Allow", "GET, POST, DELETE").status(405).end();
        return;
      }
      handleMcpRequest(req, res).catch(next);
    }
  );

  app.use((_req, res) => {
    sendError(res, 404, -32002, "Not found");
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Error handling MCP request:", error);
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, 500, -32603, "Internal server error");
  });

  const httpServer = app.listen(port, host, () => {
    console.error(
      `book-writer-mcp HTTP transport listening on http://${host}:${port}${MCP_PATH}`
    );
    console.error(`Book project directory: ${getProjectPaths().projectDir}`);
    if (oauthEnabled) {
      console.error(`OAuth enabled, issuer: ${publicUrl}`);
    } else {
      console.error(
        "OAuth disabled (MCP_PUBLIC_URL not set); static bearer token only."
      );
    }
  });

  const shutdown = async () => {
    for (const transport of Object.values(transports)) {
      await transport.close();
    }
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
