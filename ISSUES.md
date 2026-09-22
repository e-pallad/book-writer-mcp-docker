# Known issues and investigations

## claude.ai completes OAuth but `/mcp` requests arrive without a token

Referenced upstream: [claude-ai-mcp#79](https://github.com/anthropics/claude-ai-mcp/issues/79),
[#155](https://github.com/anthropics/claude-ai-mcp/issues/155),
[#162](https://github.com/anthropics/claude-ai-mcp/issues/162).

**Status: reproduced against this server, and it was our bug. Fixed** — see
`src/http/cors.ts` and the *Authentication* section of the README.

### What the symptom looks like

The connector dialog on claude.ai runs the authorization flow to completion —
registration, consent, redirect, token exchange all succeed — and then every
call fails. In the server log the request that fails carries no `Authorization`
header at all, which reads as "claude.ai never attached the token".

### Scope of what was actually tested

This was reproduced against a locally running `http-server.js` driven by a
request sequence that matches what a browser emits, not by driving the
connector dialog on claude.ai itself. The root cause below is a property of the
server's own middleware order, and is visible without any client: the server
rejects the request that a browser is obliged to send first. The fix was
verified the same way, and is covered by `tests/oauth-cors.test.js`.

What could not be checked here: whether claude.ai *also* has a bug of its own
on top of this one. If the fix below does not resolve it on your instance, run
with `MCP_DEBUG_AUTH=1` and compare against the transcripts below before
opening an upstream report — the logging is redacted and safe to paste.

### Root cause

`/mcp` had no CORS support. claude.ai's web client calls the endpoint with
`fetch()` from `https://claude.ai`, so the request is cross-origin, and a POST
carrying an `Authorization` header is not a "simple" request. Per the Fetch
standard the browser therefore sends a `OPTIONS` preflight first — and **a
preflight never carries `Authorization`**, because the browser generates it,
not the client code.

The auth middleware was mounted with `app.all(MCP_PATH, mcpAuth, …)`, so it ran
on that preflight and answered `401`. The browser then aborted and never sent
the real POST. The tokenless request in the log *is* the preflight.

Two further problems sat behind it, both of which would have broken the client
even if the preflight had passed:

- No `Access-Control-Expose-Headers`, so client JavaScript could not read
  `Mcp-Session-Id` off the `initialize` response. Streamable HTTP requires the
  client to echo that id on every subsequent request, so the session was
  unusable.
- The same omission hid `WWW-Authenticate`, so the client could not read the
  `resource_metadata` parameter out of a `401` — which is how discovery of the
  authorization server is supposed to start.

### The parts that were *not* at fault

Checked because the issue reports point at them, and all are compliant:

| Check | Result |
| --- | --- |
| `/token` `token_type` | `"Bearer"` — correct casing, RFC 6749 §5.1 |
| `/token` `expires_in` | `3600`, a JSON number, not a string |
| `/token` `Cache-Control` | `no-store`, as §5.1 requires |
| `/token` body | includes `refresh_token` and `scope` |
| Header format required | plain `Authorization: Bearer <token>`; nothing custom |
| Scheme matching | SDK accepts the scheme case-insensitively |
| `401` challenge | carries `resource_metadata=…`, per RFC 9728 |
| Discovery documents | both served, correct `issuer` and `resource` |
| PKCE | `S256` advertised and enforced |
| Dynamic client registration | works unauthenticated, as connectors expect |

### Transcripts

Captured against a local instance. Tokens, codes and the passphrase are
redacted; nothing else is edited.

#### Before the fix — the preflight a browser sends

```http
OPTIONS /mcp HTTP/1.1
Origin: https://claude.ai
Access-Control-Request-Method: POST
Access-Control-Request-Headers: authorization,content-type,mcp-protocol-version
```

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="http://localhost:3456/.well-known/oauth-protected-resource/mcp"
Content-Type: application/json; charset=utf-8

{"error":"invalid_token","error_description":"Missing Authorization header"}
```

No `Access-Control-*` header in the response, and a `401` status: the browser
treats this as a failed preflight and never sends the POST.

#### Before the fix — an authenticated POST, for contrast

The same request from a non-browser client (no preflight, so nothing to block)
always worked:

```http
POST /mcp HTTP/1.1
Authorization: Bearer <REDACTED>
Content-Type: application/json
Accept: application/json, text/event-stream
```

```http
HTTP/1.1 200 OK
content-type: text/event-stream; charset=utf-8
mcp-session-id: 4fd4b31d-29a0-45cd-a77c-6172ef1b7b46

event: message
data: {"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"book-writer-mcp","version":"1.0.0"}},"jsonrpc":"2.0","id":1}
```

Note the absent `Access-Control-Expose-Headers`: even on this success a browser
could not have read `mcp-session-id`.

#### The token exchange, which was fine throughout

```http
POST /token HTTP/1.1
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=<REDACTED>&client_id=<REDACTED>&code_verifier=<REDACTED>&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&resource=http%3A%2F%2Flocalhost%3A3456%2Fmcp
```

```http
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
Cache-Control: no-store
Content-Type: application/json; charset=utf-8

{"access_token":"<REDACTED>","token_type":"Bearer","expires_in":3600,"refresh_token":"<REDACTED>","scope":"mcp"}
```

#### After the fix — the same preflight

```http
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://claude.ai
Vary: Origin
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID
Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate, Last-Event-ID
Access-Control-Max-Age: 86400
```

#### After the fix — the `401` challenge

```http
HTTP/1.1 401 Unauthorized
Access-Control-Allow-Origin: https://claude.ai
Vary: Origin
Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate, Last-Event-ID
WWW-Authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="http://localhost:3456/.well-known/oauth-protected-resource/mcp"
```

The challenge is now readable by the client, so discovery can proceed.

### If it still fails for you

Start the server with `MCP_DEBUG_AUTH=1`. Every request is logged before
authentication runs, with the token reduced to its length and an 8-character
SHA-256 prefix:

```
[auth-debug] {"method":"POST","path":"/mcp","origin":"https://claude.ai","userAgent":"curl/8.5.0","authorization":{"present":false},"mcpSessionId":null,"mcpProtocolVersion":null,"accept":"*/*","contentType":"application/json","accessControlRequestHeaders":null,"accessControlRequestMethod":null}
```

Read it like this:

- An `OPTIONS` line followed by no `POST` line — the preflight is still being
  rejected. Check for a proxy in front of the container that strips or blocks
  `OPTIONS`; Cloudflare Tunnel passes it through, but some reverse-proxy
  configurations do not.
- A `POST` with `"present":false` and no preceding `OPTIONS` — the client
  genuinely sent no token, which *would* be an upstream bug worth reporting.
- A `POST` with `"present":true` that still gets `401` — the token is being
  rejected rather than missing. Compare `tokenFingerprint` against the entries
  in `.book-mcp/oauth.json`, which stores the same SHA-256 digest, to tell an
  expired token from an unknown one.

Include the logged lines (they carry no credential) when reporting upstream.
