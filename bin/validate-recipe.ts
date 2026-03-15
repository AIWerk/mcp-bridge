#!/usr/bin/env node
/**
 * CLI entry point for the Universal MCP Recipe Validator.
 * Usage: npx tsx bin/validate-recipe.ts <path-to-recipe.json>
 */

import { validateRecipeFile, formatValidationResult } from "../src/validate-recipe.ts";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: validate-recipe <path-to-recipe.json>");
    console.log("");
    console.log("Validates a Universal MCP Recipe against spec v2.0.");
    console.log("Exits 0 if valid, 1 if invalid.");
    process.exit(0);
  }

  const filePath = args[0];

  let result;
  try {
    result = await validateRecipeFile(filePath);
  } catch (e) {
    console.error(`❌ Could not read file: ${filePath}`);
    console.error(`   ${(e as Error).message}`);
    process.exit(1);
  }

  const output = formatValidationResult(filePath, result);
  console.log(output);

  process.exit(result.valid ? 0 : 1);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
