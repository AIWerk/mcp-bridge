#!/usr/bin/env node
/**
 * Verify Ed25519 signatures on all recipes in servers/.
 * Usage: node scripts/verify-signatures.mjs [--ci]
 *
 * --ci: exit with code 1 if any signature is invalid (for CI/pre-commit)
 *
 * Requires: public key in keys/aiwerk-public.pem (or set AIWERK_PUBLIC_KEY env var)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verify, createPublicKey } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SERVERS_DIR = join(ROOT, 'servers');

const SIGNED_FIELDS = ['id', 'name', 'description', 'transports', 'auth', 'install', 'metadata'];

function stableStringify(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => stableStringify(item)).join(',') + ']';
  }
  const sorted = Object.keys(obj).sort();
  const entries = sorted.map(key => JSON.stringify(key) + ':' + stableStringify(obj[key]));
  return '{' + entries.join(',') + '}';
}

function canonicalPayload(recipe) {
  const subset = {};
  for (const field of SIGNED_FIELDS) {
    if (field in recipe) {
      subset[field] = recipe[field];
    }
  }
  return stableStringify(subset);
}

function loadPublicKey() {
  // Try env var first
  if (process.env.AIWERK_PUBLIC_KEY) {
    const pem = Buffer.from(process.env.AIWERK_PUBLIC_KEY, 'base64').toString('utf-8');
    return createPublicKey(pem);
  }
  // Try keys/ dir
  const keyPath = join(ROOT, 'keys', 'aiwerk-public.pem');
  if (existsSync(keyPath)) {
    return createPublicKey(readFileSync(keyPath, 'utf-8'));
  }
  // Try catalog repo
  const catalogKeyPath = join(ROOT, '..', 'mcp-catalog', 'keys', 'aiwerk-public.pem');
  if (existsSync(catalogKeyPath)) {
    return createPublicKey(readFileSync(catalogKeyPath, 'utf-8'));
  }
  return null;
}

function verifySignature(recipe, signature, publicKey) {
  try {
    const payload = canonicalPayload(recipe);
    return verify(null, Buffer.from(payload, 'utf-8'), publicKey, Buffer.from(signature.value, 'base64'));
  } catch {
    return false;
  }
}

const ciMode = process.argv.includes('--ci');
const publicKey = loadPublicKey();

if (!publicKey) {
  console.error('⚠️  No public key found. Skipping signature verification.');
  console.error('   Set AIWERK_PUBLIC_KEY env var or place keys/aiwerk-public.pem');
  process.exit(ciMode ? 1 : 0);
}

const entries = readdirSync(SERVERS_DIR, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));

let total = 0;
let valid = 0;
let invalid = 0;
let unsigned = 0;

for (const entry of entries) {
  const recipePath = join(SERVERS_DIR, entry.name, 'recipe.json');
  if (!existsSync(recipePath)) continue;

  total++;
  const recipe = JSON.parse(readFileSync(recipePath, 'utf-8'));

  if (!recipe.signature) {
    unsigned++;
    console.log(`⚠️  ${entry.name}: UNSIGNED`);
    continue;
  }

  const isValid = verifySignature(recipe, recipe.signature, publicKey);
  if (isValid) {
    valid++;
    console.log(`✅ ${entry.name}: valid`);
  } else {
    invalid++;
    console.log(`❌ ${entry.name}: INVALID SIGNATURE`);
  }
}

console.log(`\n${total} recipes: ${valid} valid, ${unsigned} unsigned, ${invalid} invalid`);

if (invalid > 0) {
  console.error(`\n🚨 ${invalid} recipe(s) have invalid signatures!`);
  console.error('   Run: cd ../mcp-catalog && npx tsx scripts/sign-recipe.ts <recipe.json> --output <recipe.json>');
  process.exit(1);
}

if (unsigned > 0 && ciMode) {
  console.error(`\n⚠️  ${unsigned} recipe(s) are unsigned`);
}
