import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRecipe,
  formatValidationResult,
  type UniversalRecipe,
} from "../src/validate-recipe.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid v2 stdio recipe */
function validStdioRecipe(overrides: Partial<UniversalRecipe> = {}): UniversalRecipe {
  return {
    schemaVersion: 2,
    id: "my-server",
    name: "My Server",
    description: "A test MCP server",
    repository: "https://github.com/example/my-server",
    transports: [
      {
        type: "stdio",
        command: "npx",
        args: ["-y", "@example/my-server"],
        env: { API_KEY: "${MY_API_KEY}" },
      },
    ],
    auth: {
      required: true,
      type: "api-key",
      envVars: ["MY_API_KEY"],
    },
    install: {
      method: "npx",
      package: "@example/my-server",
    },
    metadata: {
      homepage: "https://example.com/",
      category: "productivity",
      maturity: "stable",
      lastVerified: new Date().toISOString().slice(0, 10),
      toolCount: 5,
    },
    ...overrides,
  };
}

/** Build a minimal valid v2 remote (streamable-http) recipe */
function validRemoteRecipe(overrides: Partial<UniversalRecipe> = {}): UniversalRecipe {
  return {
    schemaVersion: 2,
    id: "hosted-server",
    name: "Hosted Server",
    description: "A remote-only MCP server",
    transports: [
      {
        type: "streamable-http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer ${HOSTED_TOKEN}" },
      },
    ],
    auth: {
      required: true,
      type: "bearer",
      envVars: ["HOSTED_TOKEN"],
    },
    metadata: {
      homepage: "https://example.com/",
      category: "automation",
    },
    ...overrides,
  };
}

// ─── Valid recipes ─────────────────────────────────────────────────────────────

test("valid stdio recipe passes", () => {
  const result = validateRecipe(validStdioRecipe());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.id, "my-server");
  assert.equal(result.primaryTransport, "stdio");
  assert.equal(result.installMethod, "npx");
  assert.equal(result.toolCount, 5);
});

test("valid remote recipe passes (no install block needed)", () => {
  const result = validateRecipe(validRemoteRecipe());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("valid recipe with repository but no homepage passes", () => {
  const recipe = validStdioRecipe({ metadata: { category: "productivity" } });
  const result = validateRecipe(recipe);
  assert.equal(result.valid, true);
});

test("valid recipe with homepage but no repository passes", () => {
  const recipe = validRemoteRecipe();
  delete (recipe as UniversalRecipe).repository;
  const result = validateRecipe(recipe);
  assert.equal(result.valid, true);
});

test("valid recipe with SSE transport passes", () => {
  const result = validateRecipe({
    schemaVersion: 2,
    id: "sse-server",
    name: "SSE Server",
    description: "Server using SSE transport",
    transports: [{ type: "sse", url: "https://mcp.example.com/sse" }],
    auth: { required: false },
    metadata: { homepage: "https://example.com/" },
  });
  assert.equal(result.valid, true);
});

// ─── Missing required fields ───────────────────────────────────────────────────

test("missing schemaVersion fails", () => {
  const recipe = validStdioRecipe();
  delete recipe.schemaVersion;
  const result = validateRecipe(recipe);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("schemaVersion")));
});

test("wrong schemaVersion fails", () => {
  const result = validateRecipe(validStdioRecipe({ schemaVersion: 1 }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("schemaVersion")));
});

test("missing id fails", () => {
  const recipe = validStdioRecipe();
  delete recipe.id;
  const result = validateRecipe(recipe);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("id")));
});

test("missing name fails", () => {
  const recipe = validStdioRecipe();
  delete recipe.name;
  const result = validateRecipe(recipe);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("name")));
});

test("empty name fails", () => {
  const result = validateRecipe(validStdioRecipe({ name: "   " }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("name")));
});

test("name too long fails", () => {
  const result = validateRecipe(validStdioRecipe({ name: "x".repeat(129) }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("128")));
});

test("missing description fails", () => {
  const recipe = validStdioRecipe();
  delete recipe.description;
  const result = validateRecipe(recipe);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("description")));
});

test("description too long fails", () => {
  const result = validateRecipe(validStdioRecipe({ description: "x".repeat(513) }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("512")));
});

test("missing both repository and metadata.homepage fails", () => {
  const recipe = validStdioRecipe({ repository: undefined, metadata: { category: "productivity" } });
  const result = validateRecipe(recipe);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("repository") || e.includes("homepage")));
});

test("empty transports array fails", () => {
  const result = validateRecipe(validStdioRecipe({ transports: [] }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("transports")));
});

test("missing transports fails", () => {
  const recipe = validStdioRecipe();
  delete recipe.transports;
  const result = validateRecipe(recipe);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("transports")));
});

test("stdio transport missing command fails", () => {
  const result = validateRecipe(
    validStdioRecipe({
      transports: [{ type: "stdio" }],
    })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("command")));
});

test("sse transport missing url fails", () => {
  const result = validateRecipe({
    schemaVersion: 2,
    id: "bad-sse",
    name: "Bad SSE",
    description: "Missing URL",
    transports: [{ type: "sse" }],
    metadata: { homepage: "https://example.com/" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("url")));
});

test("streamable-http transport missing url fails", () => {
  const result = validateRecipe({
    schemaVersion: 2,
    id: "bad-http",
    name: "Bad HTTP",
    description: "Missing URL",
    transports: [{ type: "streamable-http" }],
    metadata: { homepage: "https://example.com/" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("url")));
});

test("unknown transport type fails", () => {
  const result = validateRecipe(
    validStdioRecipe({ transports: [{ type: "websocket", command: "npx" }] })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("websocket")));
});

test("stdio transport requires install block", () => {
  const recipe = validStdioRecipe();
  delete recipe.install;
  const result = validateRecipe(recipe);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("install")));
});

test("stdio transport with install missing method fails", () => {
  const result = validateRecipe(
    validStdioRecipe({ install: {} as UniversalRecipe["install"] })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("install.method")));
});

test("undeclared ${VAR} in transport env fails", () => {
  const result = validateRecipe(
    validStdioRecipe({
      transports: [
        {
          type: "stdio",
          command: "npx",
          env: { KEY: "${UNDECLARED_VAR}" },
        },
      ],
      auth: { required: true, envVars: [] },
    })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("UNDECLARED_VAR")));
});

test("undeclared ${VAR} in transport headers fails", () => {
  const result = validateRecipe(
    validRemoteRecipe({
      transports: [
        {
          type: "streamable-http",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer ${SECRET_TOKEN}" },
        },
      ],
      auth: { required: true, envVars: [] },
    })
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("SECRET_TOKEN")));
});

// ─── ID format edge cases (§7.3) ──────────────────────────────────────────────

test("id 'todoist' is valid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "todoist" }));
  assert.equal(result.valid, true);
});

test("id 'google-maps' is valid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "google-maps" }));
  assert.equal(result.valid, true);
});

test("id 'a1' is valid (minimum 2 chars)", () => {
  const result = validateRecipe(validStdioRecipe({ id: "a1" }));
  assert.equal(result.valid, true);
});

test("id 'my-server-2' is valid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "my-server-2" }));
  assert.equal(result.valid, true);
});

test("id 'a-' (trailing hyphen) is invalid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "a-" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("id")));
});

test("id '-a' (leading hyphen) is invalid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "-a" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("id")));
});

test("id 'a' (single char) is invalid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "a" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("id")));
});

test("id 'My-Server' (uppercase) is invalid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "My-Server" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("id")));
});

test("id with 65 chars is invalid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "a" + "b".repeat(63) + "c" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("64")));
});

test("id with 64 chars is valid", () => {
  const result = validateRecipe(validStdioRecipe({ id: "a" + "b".repeat(62) + "c" }));
  assert.equal(result.valid, true);
});

// ─── Warnings ─────────────────────────────────────────────────────────────────

test("lastVerified >90 days old emits warning", () => {
  const oldDate = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const result = validateRecipe(
    validStdioRecipe({ metadata: { lastVerified: oldDate, homepage: "https://example.com/", category: "productivity" } })
  );
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes("90 days")));
});

test("recent lastVerified does not emit warning", () => {
  const recentDate = new Date().toISOString().slice(0, 10);
  const result = validateRecipe(
    validStdioRecipe({ metadata: { lastVerified: recentDate, homepage: "https://example.com/", category: "productivity" } })
  );
  assert.equal(result.valid, true);
  assert.ok(!result.warnings.some((w) => w.includes("90 days")));
});

test("unknown category emits warning", () => {
  const result = validateRecipe(
    validStdioRecipe({ metadata: { homepage: "https://example.com/", category: "magic" } })
  );
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes("category")));
});

test("known category does not emit warning", () => {
  const result = validateRecipe(
    validStdioRecipe({ metadata: { homepage: "https://example.com/", category: "productivity" } })
  );
  assert.ok(!result.warnings.some((w) => w.includes("category")));
});

test("non-empty preInstall emits warning", () => {
  const result = validateRecipe(
    validStdioRecipe({
      install: { method: "npx", package: "@example/server", preInstall: ["echo hello"] },
    })
  );
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes("preInstall")));
});

test("non-empty postInstall emits warning", () => {
  const result = validateRecipe(
    validStdioRecipe({
      install: { method: "npx", package: "@example/server", postInstall: ["echo done"] },
    })
  );
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes("postInstall")));
});

test("maturity deprecated emits warning", () => {
  const result = validateRecipe(
    validStdioRecipe({ metadata: { homepage: "https://example.com/", maturity: "deprecated" } })
  );
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes("deprecated")));
});

test("missing homepage (but repository present) emits warning", () => {
  // repository is present, homepage is absent -> warning only
  const recipe = validStdioRecipe();
  recipe.metadata = { category: "productivity" }; // no homepage
  const result = validateRecipe(recipe);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes("homepage")));
});

// ─── Output formatting ─────────────────────────────────────────────────────────

test("formatValidationResult includes ✅ on success", () => {
  const result = validateRecipe(validStdioRecipe());
  const output = formatValidationResult("servers/my-server/recipe.json", result);
  assert.ok(output.includes("✅"));
  assert.ok(output.includes("my-server"));
});

test("formatValidationResult includes ❌ on failure", () => {
  const result = validateRecipe(validStdioRecipe({ name: "" }));
  const output = formatValidationResult("servers/bad/recipe.json", result);
  assert.ok(output.includes("❌"));
  assert.ok(output.includes("servers/bad/recipe.json"));
});

test("formatValidationResult includes ⚠️ for warnings", () => {
  const result = validateRecipe(
    validStdioRecipe({ metadata: { homepage: "https://example.com/", category: "magic" } })
  );
  const output = formatValidationResult("servers/my-server/recipe.json", result);
  assert.ok(output.includes("⚠️"));
});

// ─── Complex / multi-transport ─────────────────────────────────────────────────

test("multi-transport (stdio + http) with auth.envVars covering both passes", () => {
  const result = validateRecipe({
    schemaVersion: 2,
    id: "dual-transport",
    name: "Dual Transport",
    description: "Available locally and as hosted service",
    transports: [
      {
        type: "stdio",
        command: "npx",
        args: ["-y", "@example/server"],
        env: { API_KEY: "${EXAMPLE_API_KEY}" },
      },
      {
        type: "streamable-http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer ${EXAMPLE_API_KEY}" },
      },
    ],
    auth: {
      required: true,
      type: "api-key",
      envVars: ["EXAMPLE_API_KEY"],
    },
    install: {
      method: "npx",
      package: "@example/server",
    },
    metadata: {
      homepage: "https://example.com/",
      category: "other",
    },
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("multiple errors reported together", () => {
  const result = validateRecipe({
    schemaVersion: 1,
    id: "Bad-ID",
    name: "",
    description: "",
    transports: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 4, `Expected >=4 errors, got ${result.errors.length}: ${result.errors.join("; ")}`);
});
