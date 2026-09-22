import * as fs from "fs";
import * as path from "path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getProjectPaths } from "../storage/filestore";

const STORE_FILE = "oauth.json";

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt?: number;
}

interface StoreShape {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, AuthorizationCodeRecord>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

function emptyStore(): StoreShape {
  return { clients: {}, codes: {}, accessTokens: {}, refreshTokens: {} };
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

// Compares hashes so the check runs in constant time regardless of input length.
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * OAuth state persisted next to the book data, so a container restart does not
 * disconnect an already-authorized connector. Codes and tokens are keyed by
 * their SHA-256 digest, so the file never holds a usable credential.
 *
 * Unlike the project's JSON documents this class needs no async lock. It holds
 * the whole store in memory and every mutator is synchronous — read, change,
 * write all happen in one tick, so no second call can interleave. Making these
 * methods async to take a lock would change the OAuthServerProvider surface
 * for no gain.
 */
export class OAuthStore {
  private data: StoreShape = emptyStore();
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || path.join(getProjectPaths().mcpDir, STORE_FILE);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.data = { ...emptyStore(), ...JSON.parse(raw) };
    } catch (error) {
      console.error(
        `Ignoring unreadable OAuth store at ${this.filePath}:`,
        (error as Error).message
      );
      this.data = emptyStore();
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Written via a temp file so a crash mid-write cannot truncate the store.
    // The name is unique per write: a fixed ".tmp" would be shared by two
    // processes pointed at one project directory, and the loser of that race
    // would rename a file the winner was still writing.
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmp, this.filePath);
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.data.clients[clientId];
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.data.clients[client.client_id] = client;
    this.save();
  }

  saveCode(code: string, record: AuthorizationCodeRecord): void {
    this.data.codes[digest(code)] = record;
    this.save();
  }

  peekCode(code: string): AuthorizationCodeRecord | undefined {
    return this.data.codes[digest(code)];
  }

  // Authorization codes are single use: reading one removes it.
  takeCode(code: string): AuthorizationCodeRecord | undefined {
    const key = digest(code);
    const record = this.data.codes[key];
    if (!record) return undefined;
    delete this.data.codes[key];
    this.save();
    return record;
  }

  saveAccessToken(token: string, record: TokenRecord): void {
    this.data.accessTokens[digest(token)] = record;
    this.save();
  }

  getAccessToken(token: string): TokenRecord | undefined {
    return this.data.accessTokens[digest(token)];
  }

  saveRefreshToken(token: string, record: TokenRecord): void {
    this.data.refreshTokens[digest(token)] = record;
    this.save();
  }

  takeRefreshToken(token: string): TokenRecord | undefined {
    const key = digest(token);
    const record = this.data.refreshTokens[key];
    if (!record) return undefined;
    delete this.data.refreshTokens[key];
    this.save();
    return record;
  }

  revokeToken(token: string): void {
    const key = digest(token);
    delete this.data.accessTokens[key];
    delete this.data.refreshTokens[key];
    this.save();
  }

  /** Drops codes and access tokens that are already past their expiry. */
  pruneExpired(): void {
    const now = Date.now();
    let changed = false;

    for (const [key, record] of Object.entries(this.data.codes)) {
      if (record.expiresAt <= now) {
        delete this.data.codes[key];
        changed = true;
      }
    }
    for (const [key, record] of Object.entries(this.data.accessTokens)) {
      if (record.expiresAt && record.expiresAt * 1000 <= now) {
        delete this.data.accessTokens[key];
        changed = true;
      }
    }

    if (changed) this.save();
  }
}
