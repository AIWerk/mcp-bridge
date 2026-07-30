import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigFiles, getConfigFilesServerDir, getConfigFilesBaseDir } from "../src/config-files.ts";

function tempBase(): string {
  return mkdtempSync(join(tmpdir(), "mcp-bridge-configfiles-"));
}

test("writeConfigFiles writes each file under <base>/<serverName>/<name>", () => {
  const base = tempBase();
  try {
    const dir = writeConfigFiles(
      "dbhub",
      [{ name: "dbhub.toml", content: '[[sources]]\nid = "default"\ndsn = "${DSN}"\n' }],
      base
    );
    assert.equal(dir, join(base, "dbhub"));
    const content = readFileSync(join(dir, "dbhub.toml"), "utf-8");
    assert.equal(content, '[[sources]]\nid = "default"\ndsn = "${DSN}"\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeConfigFiles writes file with 0600 perms", () => {
  const base = tempBase();
  try {
    const dir = writeConfigFiles("dbhub", [{ name: "dbhub.toml", content: "x = 1\n" }], base);
    const mode = statSync(join(dir, "dbhub.toml")).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600 perms, got ${mode.toString(8)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeConfigFiles is idempotent: identical content is not rewritten", () => {
  const base = tempBase();
  try {
    const content = "x = 1\n";
    const dir = writeConfigFiles("dbhub", [{ name: "dbhub.toml", content }], base);
    const filePath = join(dir, "dbhub.toml");

    // Backdate mtime, then write the same content again — mtime must not change.
    const past = new Date(Date.now() - 60_000);
    utimesSync(filePath, past, past);
    const before = statSync(filePath).mtimeMs;

    writeConfigFiles("dbhub", [{ name: "dbhub.toml", content }], base);
    const after = statSync(filePath).mtimeMs;

    assert.equal(after, before, "identical content must not trigger a rewrite");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeConfigFiles overwrites when content changes", () => {
  const base = tempBase();
  try {
    const dir = writeConfigFiles("dbhub", [{ name: "dbhub.toml", content: "x = 1\n" }], base);
    writeConfigFiles("dbhub", [{ name: "dbhub.toml", content: "x = 2\n" }], base);
    assert.equal(readFileSync(join(dir, "dbhub.toml"), "utf-8"), "x = 2\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeConfigFiles rejects unsafe file names", () => {
  const base = tempBase();
  try {
    assert.throws(
      () => writeConfigFiles("dbhub", [{ name: "../../etc/passwd", content: "x" }], base),
      /unsafe name/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("getConfigFilesServerDir respects MCP_BRIDGE_CONFIG_FILES_DIR env", () => {
  const original = process.env.MCP_BRIDGE_CONFIG_FILES_DIR;
  process.env.MCP_BRIDGE_CONFIG_FILES_DIR = "/tmp/custom-config-dir";
  try {
    assert.equal(getConfigFilesServerDir("dbhub"), "/tmp/custom-config-dir/dbhub");
    assert.equal(getConfigFilesBaseDir(), "/tmp/custom-config-dir");
  } finally {
    if (original === undefined) delete process.env.MCP_BRIDGE_CONFIG_FILES_DIR;
    else process.env.MCP_BRIDGE_CONFIG_FILES_DIR = original;
  }
});
