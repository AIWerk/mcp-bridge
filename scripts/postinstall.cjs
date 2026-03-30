#!/usr/bin/env node

// Only run auto-init on global installs, not when installed as a dependency
// npm sets npm_config_global=true for global installs
const isGlobal = process.env.npm_config_global === "true" || 
                 process.env.npm_lifecycle_event === "postinstall" && 
                 !process.env.npm_package_name; // not set when we ARE the package being installed as dep

// Also check: if our parent is another package's node_modules, skip
const isNested = __dirname.includes("node_modules") && 
                 __dirname.split("node_modules").length > 2;

if (isNested) {
  // We're a nested dependency (e.g., inside openclaw-mcp-bridge), skip
  process.exit(0);
}

const { execSync } = require("child_process");
const { existsSync } = require("fs");
const { join } = require("path");
const os = require("os");

const configDir = join(os.homedir(), ".mcp-bridge");
const configPath = join(configDir, "config.json");

// Only auto-init if config doesn't exist yet (fresh install)
if (existsSync(configPath)) {
  console.log("[mcp-bridge] Config already exists, skipping auto-init.");
  process.exit(0);
}

try {
  // Find our own binary
  const binPath = join(__dirname, "..", "dist", "bin", "mcp-bridge.js");
  if (!existsSync(binPath)) {
    // Not built yet (source install), skip
    process.exit(0);
  }
  
  console.log("[mcp-bridge] Running auto-init...");
  execSync(`node "${binPath}" init`, { stdio: "inherit" });
} catch (err) {
  // Don't fail the install if init fails
  console.log("[mcp-bridge] Auto-init skipped (non-fatal):", err.message || err);
}
