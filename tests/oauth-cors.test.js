const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { startHttpServer } = require("./helpers/server");

const b64url = (buf) => buf.toString("base64url");

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// Walks the whole authorization-code flow the way a connector does, and hands
// back the raw /token response so its shape can be asserted against RFC 6749.
async function runOAuthFlow(base, { passphrase = "test-passphrase" } = {}) {
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";

  const register = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(register.status, 201, "dynamic client registration should succeed");
  const client = await register.json();

  const { verifier, challenge } = pkce();
  const authorizeUrl = new URL(`${base}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-value",
    scope: "mcp",
  }).toString();

  const loginPage = await (await fetch(authorizeUrl)).text();
  const authId = /name="auth_id" value="([^"]+)"/.exec(loginPage)?.[1];
  assert.ok(authId, "the authorize page should carry an auth_id");

  const consent = await fetch(`${base}/authorize/consent`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ auth_id: authId, passphrase }),
    redirect: "manual",
  });
  assert.equal(consent.status, 302, "the correct passphrase should redirect back");
  const callback = new URL(consent.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "state-value");
  const code = callback.searchParams.get("code");
  assert.ok(code, "the redirect should carry an authorization code");

  const tokenResponse = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  return { tokenResponse, client, redirectUri };
}

test("CORS preflight on /mcp is answered without a token", async (t) => {
  const server = await startHttpServer({ MCP_PUBLIC_URL: "http://localhost" });
  t.after(() => server.stop());

  // A browser generates this request itself and never attaches Authorization.
  // Rejecting it means the authenticated POST that follows is never sent.
  const res = await fetch(`${server.base}/mcp`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://claude.ai",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });

  assert.ok(
    res.status >= 200 && res.status < 300,
    `preflight must succeed, got ${res.status}`
  );
  assert.equal(res.headers.get("access-control-allow-origin"), "https://claude.ai");
  assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(
    (res.headers.get("access-control-allow-headers") ?? "").toLowerCase(),
    /authorization/
  );
});

test("browser clients can read Mcp-Session-Id and WWW-Authenticate", async (t) => {
  const server = await startHttpServer({ MCP_PUBLIC_URL: "http://localhost" });
  t.after(() => server.stop());

  const unauthorized = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://claude.ai" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
  });
  assert.equal(unauthorized.status, 401);

  const exposed = (unauthorized.headers.get("access-control-expose-headers") ?? "")
    .toLowerCase();
  // Without this the client cannot read the challenge, so it cannot find the
  // resource_metadata URL that starts the OAuth flow.
  assert.match(exposed, /www-authenticate/);
  assert.match(exposed, /mcp-session-id/);
  assert.match(
    unauthorized.headers.get("www-authenticate") ?? "",
    /resource_metadata=/
  );
});

test("the full authorization-code flow issues a spec-compliant token", async (t) => {
  const server = await startHttpServer({ MCP_PUBLIC_URL: "http://localhost" });
  t.after(() => server.stop());

  const { tokenResponse } = await runOAuthFlow(server.base);
  assert.equal(tokenResponse.status, 200);
  assert.equal(
    tokenResponse.headers.get("cache-control"),
    "no-store",
    "RFC 6749 §5.1 requires no-store on a token response"
  );

  const tokens = await tokenResponse.json();
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(typeof tokens.expires_in, "number");
  assert.ok(tokens.expires_in > 0);
  assert.equal(typeof tokens.access_token, "string");
  assert.ok(tokens.access_token.length > 0);
  assert.equal(typeof tokens.refresh_token, "string");
  assert.equal(tokens.scope, "mcp");

  // And the token the server just issued is actually accepted on /mcp.
  const mcp = await fetch(`${server.base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Origin: "https://claude.ai",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
  assert.equal(mcp.status, 200);
  assert.ok(mcp.headers.get("mcp-session-id"), "initialize should issue a session id");
  assert.equal(mcp.headers.get("access-control-allow-origin"), "https://claude.ai");
});

test("a wrong passphrase does not issue a code", async (t) => {
  const server = await startHttpServer({ MCP_PUBLIC_URL: "http://localhost" });
  t.after(() => server.stop());

  await assert.rejects(() => runOAuthFlow(server.base, { passphrase: "wrong" }));
});

test("the static bearer token still works, with and without OAuth enabled", async (t) => {
  for (const env of [{}, { MCP_PUBLIC_URL: "http://localhost" }]) {
    const server = await startHttpServer(env);
    try {
      const res = await fetch(`${server.base}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-static-token",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      });
      assert.equal(res.status, 200);
    } finally {
      await server.stop();
    }
  }
});

test("MCP_ALLOWED_ORIGINS locks the server to the listed origins", async (t) => {
  const server = await startHttpServer({
    MCP_PUBLIC_URL: "http://localhost",
    MCP_ALLOWED_ORIGINS: "https://claude.ai",
  });
  t.after(() => server.stop());

  const allowed = await fetch(`${server.base}/mcp`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://claude.ai",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://claude.ai");

  const denied = await fetch(`${server.base}/mcp`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://evil.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});
