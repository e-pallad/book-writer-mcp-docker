import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { OAuthStore, randomSecret, secretsMatch } from "./store";

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const PENDING_TTL_MS = 10 * 60 * 1000;

export const CONSENT_PATH = "/authorize/consent";

interface PendingAuthorization {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
  expiresAt: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A single-owner authorization server. There are no user accounts: whoever can
 * supply the configured passphrase is the owner of the book project, which is
 * the same trust model as the static bearer token.
 */
export class BookOAuthProvider implements OAuthServerProvider {
  private readonly store: OAuthStore;
  private readonly passphrase: string;
  private readonly resourceUrl: string;
  // Held in memory only: an interrupted login is meant to be restarted.
  private readonly pending = new Map<string, PendingAuthorization>();

  constructor(options: { store: OAuthStore; passphrase: string; resourceUrl: string }) {
    this.store = options.store;
    this.passphrase = options.passphrase;
    this.resourceUrl = options.resourceUrl;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.getClient(clientId),
      // Claude registers itself dynamically; any client may register, but it
      // still has to pass the passphrase before a code is issued.
      registerClient: (client) => {
        const registered = client as OAuthClientInformationFull;
        this.store.saveClient(registered);
        return registered;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    this.prunePending();

    const authId = randomUUID();
    this.pending.set(authId, {
      clientId: client.client_id,
      clientName: client.client_name || client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes || [],
      state: params.state,
      resource: params.resource?.href,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(this.renderLoginPage(authId, client.client_name || client.client_id));
  }

  /**
   * Handles the passphrase form. The pending record holds the redirect URI and
   * PKCE challenge, so nothing security-relevant is taken from this request.
   */
  handleConsent(req: Request, res: Response): void {
    const authId = typeof req.body?.auth_id === "string" ? req.body.auth_id : "";
    const passphrase =
      typeof req.body?.passphrase === "string" ? req.body.passphrase : "";

    const record = this.pending.get(authId);
    if (!record || record.expiresAt <= Date.now()) {
      this.pending.delete(authId);
      res.status(400).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        this.renderMessagePage("This login has expired. Start the connection again from Claude.")
      );
      return;
    }

    if (!secretsMatch(passphrase, this.passphrase)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(this.renderLoginPage(authId, record.clientName, "Incorrect passphrase."));
      return;
    }

    this.pending.delete(authId);

    const code = randomSecret();
    this.store.saveCode(code, {
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      codeChallenge: record.codeChallenge,
      scopes: record.scopes,
      resource: record.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const target = new URL(record.redirectUri);
    target.searchParams.set("code", code);
    if (record.state !== undefined) {
      target.searchParams.set("state", record.state);
    }
    res.redirect(target.href);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.store.peekCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Unknown or expired authorization code");
    }
    if (record.expiresAt <= Date.now()) {
      this.store.takeCode(authorizationCode);
      throw new InvalidGrantError("Authorization code has expired");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    // Single use: the code is consumed here whether or not the checks pass.
    const record = this.store.takeCode(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Unknown or expired authorization code");
    }
    if (record.expiresAt <= Date.now()) {
      throw new InvalidGrantError("Authorization code has expired");
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError("Redirect URI does not match the authorization request");
    }
    // RFC 8707: the token is bound to the resource named at authorize time.
    if (resource && record.resource && resource.href !== record.resource) {
      throw new InvalidGrantError("Resource does not match the authorization request");
    }

    return this.issueTokens(client.client_id, record.scopes, record.resource || resource?.href);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.store.takeRefreshToken(refreshToken);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError("Unknown or revoked refresh token");
    }
    if (resource && record.resource && resource.href !== record.resource) {
      throw new InvalidGrantError("Resource does not match the original grant");
    }

    // A refresh may narrow the granted scopes but never widen them.
    const granted = scopes?.length
      ? scopes.filter((scope) => record.scopes.includes(scope))
      : record.scopes;

    return this.issueTokens(client.client_id, granted, record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getAccessToken(token);
    if (!record) {
      throw new InvalidTokenError("Token is not valid");
    }
    if (record.expiresAt && record.expiresAt * 1000 <= Date.now()) {
      this.store.revokeToken(token);
      throw new InvalidTokenError("Token has expired");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(record.resource || this.resourceUrl),
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.store.revokeToken(request.token);
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: string
  ): OAuthTokens {
    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;

    try {
      this.store.saveAccessToken(accessToken, { clientId, scopes, resource, expiresAt });
      this.store.saveRefreshToken(refreshToken, { clientId, scopes, resource });
    } catch (error) {
      throw new ServerError(`Could not persist tokens: ${(error as Error).message}`);
    }

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private prunePending(): void {
    const now = Date.now();
    for (const [id, record] of this.pending) {
      if (record.expiresAt <= now) {
        this.pending.delete(id);
      }
    }
  }

  private renderLoginPage(authId: string, clientName: string, error?: string): string {
    const errorBlock = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
    return this.page(`
      <h1>Connect to your book</h1>
      <p><strong>${escapeHtml(clientName)}</strong> is asking to use your book-writer-mcp server.</p>
      ${errorBlock}
      <form method="post" action="${CONSENT_PATH}">
        <input type="hidden" name="auth_id" value="${escapeHtml(authId)}" />
        <label for="passphrase">Passphrase</label>
        <input type="password" id="passphrase" name="passphrase" autocomplete="current-password" autofocus required />
        <button type="submit">Authorize</button>
      </form>
    `);
  }

  private renderMessagePage(message: string): string {
    return this.page(`<h1>Book Writer MCP</h1><p>${escapeHtml(message)}</p>`);
  }

  private page(body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Book Writer MCP</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; padding: 24px; }
  main { width: 100%; max-width: 22rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
  p { margin: 0 0 1rem; line-height: 1.5; }
  label { display: block; font-size: 0.875rem; margin-bottom: 0.375rem; }
  input { width: 100%; box-sizing: border-box; padding: 0.625rem; font-size: 1rem;
          border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; }
  button { width: 100%; margin-top: 1rem; padding: 0.625rem; font-size: 1rem; font-weight: 600;
           border: 0; border-radius: 6px; background: #4338ca; color: #fff; cursor: pointer; }
  .error { color: #b91c1c; font-size: 0.875rem; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  }
}
