import test from "node:test";
import assert from "node:assert/strict";
import { resolveEnvVars, resolveEnvRecord, resolveArgs } from "../src/transport-base.ts";
import { resetOpenClawDotEnvCache } from "../src/config.ts";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

test("resolveEnvRecord throws when env var is missing", () => {
  assert.throws(
    () => resolveEnvRecord({ TOKEN: "${MISSING_TEST_ENV}" }, "env key"),
    /Missing required environment variable/
  );
});

test("resolveArgs resolves env vars in args", () => {
  const env = { MY_TOKEN: "secret123" };
  const result = resolveArgs(["--token", "${MY_TOKEN}", "--verbose"], env);
  assert.deepStrictEqual(result, ["--token", "secret123", "--verbose"]);
});

test("resolveArgs throws when env var is missing in args", () => {
  assert.throws(
    () => resolveArgs(["--token", "${MISSING_TEST_ENV}"], {}),
    /Missing required environment variable/
  );
});

test("resolveArgs passes through args without variables", () => {
  const result = resolveArgs(["-y", "@llmindset/mcp-miro", "--verbose"], {});
  assert.deepStrictEqual(result, ["-y", "@llmindset/mcp-miro", "--verbose"]);
});

test("resolveEnvRecord resolves headers with env vars", () => {
  process.env.__TEST_MCP_TOKEN = "test-secret-456";
  try {
    const result = resolveEnvRecord(
      { Authorization: "Bearer ${__TEST_MCP_TOKEN}" },
      "header"
    );
    assert.deepStrictEqual(result, { Authorization: "Bearer test-secret-456" });
  } finally {
    delete process.env.__TEST_MCP_TOKEN;
  }
});

test("resolveEnvRecord throws for missing header env var", () => {
  assert.throws(
    () => resolveEnvRecord({ Authorization: "Bearer ${MISSING_TEST_ENV}" }, "header"),
    /Missing required environment variable/
  );
});

test("resolveEnvVars resolves single value", () => {
  process.env.__TEST_MCP_SINGLE = "hello";
  try {
    const result = resolveEnvVars("prefix-${__TEST_MCP_SINGLE}-suffix", "test");
    assert.equal(result, "prefix-hello-suffix");
  } finally {
    delete process.env.__TEST_MCP_SINGLE;
  }
});

test("resolveEnvVars uses extraEnv before process.env", () => {
  process.env.__TEST_MCP_PRIO = "from-process";
  try {
    const result = resolveEnvVars("${__TEST_MCP_PRIO}", "test", { __TEST_MCP_PRIO: "from-extra" });
    assert.equal(result, "from-extra");
  } finally {
    delete process.env.__TEST_MCP_PRIO;
  }
});

test("resolveEnvVars falls back to OpenClaw .env when process.env value is empty", () => {
  // Simulate: process.env has empty string (dotenv override:false didn't overwrite)
  // but ~/.openclaw/.env has the correct value
  const openclawDir = join(homedir(), ".openclaw");
  const envPath = join(openclawDir, ".env");

  // Read existing .env content to restore later
  let originalContent: string | null = null;
  if (existsSync(envPath)) {
    originalContent = readFileSync(envPath, "utf-8");
  }

  try {
    // Append test var to .env
    mkdirSync(openclawDir, { recursive: true });
    const testLine = "\n__TEST_FALLBACK_TOKEN=ATATT3xFake123==\n";
    if (originalContent !== null) {
      writeFileSync(envPath, originalContent + testLine);
    } else {
      writeFileSync(envPath, testLine);
    }

    // Set process.env to empty string (simulating dotenv override:false issue)
    process.env.__TEST_FALLBACK_TOKEN = "";
    resetOpenClawDotEnvCache();

    const result = resolveEnvVars("${__TEST_FALLBACK_TOKEN}", "test");
    assert.equal(result, "ATATT3xFake123==", "Should fall back to .env value when process.env is empty");
  } finally {
    delete process.env.__TEST_FALLBACK_TOKEN;
    resetOpenClawDotEnvCache();
    // Restore original .env
    if (originalContent !== null) {
      writeFileSync(envPath, originalContent);
    }
  }
});
