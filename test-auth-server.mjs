#!/usr/bin/env node
/**
 * Minimal mock OAuth2 Authorization Server for testing
 * mcp-bridge auth login flow.
 *
 * Usage: node test-auth-server.mjs
 * Then:  mcp-bridge auth login test-server
 */
import { createServer } from "http";
import { URL } from "url";

const PORT = 8899;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Authorization endpoint — shows a "login" page
  if (url.pathname === "/authorize") {
    const state = url.searchParams.get("state");
    const redirectUri = url.searchParams.get("redirect_uri");
    const codeChallenge = url.searchParams.get("code_challenge");

    console.log("\n📥 Authorization request received:");
    console.log(`   redirect_uri: ${redirectUri}`);
    console.log(`   state: ${state}`);
    console.log(`   code_challenge: ${codeChallenge?.substring(0, 20)}...`);
    console.log(`   scopes: ${url.searchParams.get("scope")}`);

    // Auto-approve: redirect back with a fake code
    const callback = `${redirectUri}?code=FAKE_AUTH_CODE_12345&state=${state}`;
    res.writeHead(302, { Location: callback });
    res.end();
    console.log("✅ Auto-approved, redirecting to callback...");
    return;
  }

  // Token endpoint
  if (url.pathname === "/token" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      console.log("\n📥 Token exchange request:");
      console.log(`   grant_type: ${params.get("grant_type")}`);
      console.log(`   code: ${params.get("code")}`);
      console.log(`   code_verifier length: ${params.get("code_verifier")?.length}`);

      const token = {
        access_token: "test_access_token_" + Date.now(),
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "test_refresh_token_" + Date.now(),
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(token));
      console.log("✅ Token issued:", token.access_token.substring(0, 30) + "...");
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\n🔐 Mock OAuth2 Server running on http://localhost:${PORT}`);
  console.log(`\nTo test, add this to ~/.mcp-bridge/config.json:\n`);
  console.log(JSON.stringify({
    "test-server": {
      transport: "streamable-http",
      url: "https://httpbin.org/post",
      auth: {
        type: "oauth2",
        grantType: "authorization_code",
        authorizationUrl: `http://localhost:${PORT}/authorize`,
        tokenUrl: `http://localhost:${PORT}/token`,
        clientId: "test-client-123",
        scopes: ["read", "write"]
      }
    }
  }, null, 2));
  console.log(`\nThen run: mcp-bridge auth login test-server\n`);
});
