import { createHash } from "crypto";
import { NextFunction, Request, Response } from "express";

// Opt-in request logging for diagnosing connector auth problems. It runs
// before the auth middleware so a rejected request is still logged — that is
// the case worth seeing, since "the client sent no token" and "the client sent
// a token the server rejected" look identical from the outside otherwise.
//
// Nothing here can leak a credential: the token is reduced to its length and
// the first 8 hex characters of its SHA-256, which is enough to tell two
// tokens apart and to match a request against the store, but not enough to
// reconstruct one.

function describeAuthorization(header: string | undefined): Record<string, unknown> {
  if (!header) return { present: false };

  const spaceIndex = header.indexOf(" ");
  const scheme = spaceIndex === -1 ? header : header.slice(0, spaceIndex);
  const value = spaceIndex === -1 ? "" : header.slice(spaceIndex + 1).trim();

  return {
    present: true,
    scheme,
    // A client that sends "bearer" or "BEARER" is still spec-compliant:
    // RFC 7235 makes the scheme case-insensitive.
    schemeIsBearerCaseInsensitive: scheme.toLowerCase() === "bearer",
    tokenLength: value.length,
    tokenFingerprint: value
      ? createHash("sha256").update(value).digest("hex").slice(0, 8)
      : null,
  };
}

export function createAuthDebugMiddleware() {
  return function authDebug(req: Request, _res: Response, next: NextFunction): void {
    console.error(
      "[auth-debug] " +
        JSON.stringify({
          method: req.method,
          path: req.path,
          origin: req.headers.origin ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          authorization: describeAuthorization(req.headers.authorization),
          mcpSessionId: req.headers["mcp-session-id"] ?? null,
          mcpProtocolVersion: req.headers["mcp-protocol-version"] ?? null,
          accept: req.headers.accept ?? null,
          contentType: req.headers["content-type"] ?? null,
          accessControlRequestHeaders:
            req.headers["access-control-request-headers"] ?? null,
          accessControlRequestMethod:
            req.headers["access-control-request-method"] ?? null,
        })
    );
    next();
  };
}
