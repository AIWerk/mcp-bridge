import test from "node:test";
import assert from "node:assert/strict";
import { OAuth2TokenManager } from "../src/oauth2-token-manager.ts";
import { resolveOauth2EnvAsync } from "../src/transport-base.ts";
import { recipeToServerConfig } from "../src/config.ts";
import type { CatalogRecipe } from "../src/catalog-client.ts";
import type { Logger, McpServerConfig } from "../src/types.ts";

function makeLogger(): Logger {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

test("recipeToServerConfig plumbs auth.oauth2.envBinding through to McpServerConfig.oauth2EnvBinding", () => {
  const recipe = {
    id: "github",
    name: "GitHub",
    description: "GitHub API",
    transports: [{ type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" } }],
    auth: {
      type: "oauth",
      required: true,
      oauth2: {
        envBinding: "GITHUB_PERSONAL_ACCESS_TOKEN",
      },
    },
  } as unknown as CatalogRecipe;

  const cfg = recipeToServerConfig(recipe);
  assert.equal(cfg?.oauth2EnvBinding, "GITHUB_PERSONAL_ACCESS_TOKEN");
  assert.equal(cfg?.transport, "stdio");
});

test("recipeToServerConfig plumbs auth.oauth2.credentialsFileType through to McpServerConfig.oauth2CredentialsFile", () => {
  const recipe = {
    id: "google-workspace",
    name: "Google Workspace",
    description: "Google Workspace tools",
    transports: [{ type: "stdio", command: "uvx", args: ["workspace-mcp"] }],
    auth: {
      type: "oauth2",
      required: true,
      oauth2: {
        credentialsFileType: "google-workspace",
      },
    },
  } as unknown as CatalogRecipe;

  const cfg = recipeToServerConfig(recipe);
  assert.equal(cfg?.oauth2CredentialsFile?.format, "google-workspace");
});

test("recipeToServerConfig: missing oauth2 fields produce no extras", () => {
  const recipe = {
    id: "tavily",
    name: "Tavily",
    description: "Tavily search",
    transports: [{ type: "stdio", command: "npx", args: ["-y", "tavily-mcp"] }],
    auth: { type: "bearer", required: true, envVars: ["TAVILY_API_KEY"] },
  } as unknown as CatalogRecipe;

  const cfg = recipeToServerConfig(recipe);
  assert.equal(cfg?.oauth2EnvBinding, undefined);
  assert.equal(cfg?.oauth2CredentialsFile, undefined);
});

test("resolveOauth2EnvAsync returns {[envBinding]: token} when configured", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request): Promise<Response> => {
    if (String(url) === "https://auth.example.com/token") {
      return new Response(
        JSON.stringify({ access_token: "github-pat-xyz", token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch: ${String(url)}`);
  }) as typeof fetch;

  try {
    const manager = new OAuth2TokenManager(makeLogger());
    const config: McpServerConfig = {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      auth: {
        type: "oauth2",
        clientId: "client-x",
        clientSecret: "secret-x",
        tokenUrl: "https://auth.example.com/token",
      },
      oauth2EnvBinding: "GITHUB_PERSONAL_ACCESS_TOKEN",
    };

    const env = await resolveOauth2EnvAsync(config, manager);
    assert.deepEqual(env, { GITHUB_PERSONAL_ACCESS_TOKEN: "github-pat-xyz" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveOauth2EnvAsync returns {} when no envBinding is configured", async () => {
  const manager = new OAuth2TokenManager(makeLogger());
  const config: McpServerConfig = {
    transport: "stdio",
    command: "npx",
    args: ["-y", "tavily-mcp"],
    auth: { type: "bearer", token: "tav-xyz" },
  };

  const env = await resolveOauth2EnvAsync(config, manager);
  assert.deepEqual(env, {});
});

test("resolveOauth2EnvAsync returns {} when envBinding set but auth is not oauth2", async () => {
  const manager = new OAuth2TokenManager(makeLogger());
  const config: McpServerConfig = {
    transport: "stdio",
    command: "x",
    auth: { type: "bearer", token: "tav-xyz" },
    oauth2EnvBinding: "STRAY",
  };

  const env = await resolveOauth2EnvAsync(config, manager);
  assert.deepEqual(env, {});
});
