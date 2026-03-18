import { readFileSync, writeFileSync, unlinkSync, readdirSync, existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenUrl: string;
  clientId?: string;
  scopes?: string[];
}

export interface TokenStore {
  load(serverName: string): StoredToken | null;
  save(serverName: string, token: StoredToken): void;
  remove(serverName: string): void;
  list(): { serverName: string; token: StoredToken }[];
}

const DEFAULT_TOKENS_DIR = join(homedir(), ".mcp-bridge", "tokens");

export class FileTokenStore implements TokenStore {
  private readonly tokensDir: string;

  constructor(tokensDir?: string) {
    this.tokensDir = tokensDir ?? DEFAULT_TOKENS_DIR;
  }

  load(serverName: string): StoredToken | null {
    const filePath = this.tokenPath(serverName);
    if (!existsSync(filePath)) return null;

    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      if (!raw.accessToken || !raw.tokenUrl || typeof raw.expiresAt !== "number") {
        return null;
      }
      return raw as StoredToken;
    } catch {
      return null;
    }
  }

  save(serverName: string, token: StoredToken): void {
    this.ensureDir();
    const filePath = this.tokenPath(serverName);
    writeFileSync(filePath, JSON.stringify(token, null, 2) + "\n", "utf-8");
    try {
      chmodSync(filePath, 0o600);
    } catch { /* Windows doesn't support chmod */ }
  }

  remove(serverName: string): void {
    const filePath = this.tokenPath(serverName);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  list(): { serverName: string; token: StoredToken }[] {
    if (!existsSync(this.tokensDir)) return [];

    const results: { serverName: string; token: StoredToken }[] = [];
    for (const file of readdirSync(this.tokensDir)) {
      if (!file.endsWith(".json")) continue;
      const serverName = file.slice(0, -5);
      const token = this.load(serverName);
      if (token) {
        results.push({ serverName, token });
      }
    }
    return results;
  }

  private tokenPath(serverName: string): string {
    // Sanitize server name to prevent path traversal
    const safe = serverName.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.tokensDir, `${safe}.json`);
  }

  private ensureDir(): void {
    if (!existsSync(this.tokensDir)) {
      mkdirSync(this.tokensDir, { recursive: true });
      try {
        chmodSync(this.tokensDir, 0o700);
      } catch { /* Windows */ }
    }
  }
}
