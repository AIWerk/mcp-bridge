#!/usr/bin/env node

// Bootstrap: run the TypeScript entry point via tsx
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("tsx/esm", pathToFileURL("./"));

const { default: _ } = await import("./mcp-bridge.ts");
