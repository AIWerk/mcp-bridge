import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";

import {
  CatalogClient,
  CatalogError,
  CatalogSignatureError,
  verifyRecipeSignature,
  type CatalogRecipe,
} from "../src/catalog-client.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "mcp-bridge-catalog-test-"));
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    sorted
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

const SIGNED_FIELDS = [
  "id",
  "name",
  "description",
  "transports",
  "auth",
  "install",
  "metadata",
  "skill",
  "localOnly",
];

function canonicalSignedPayload(recipe: Record<string, unknown>): string {
  const subset: Record<string, unknown> = {};
  for (const field of SIGNED_FIELDS) {
    if (field in recipe) subset[field] = recipe[field];
  }
  return stableStringify(subset);
}

/** Sign a recipe with a fresh key pair — used to inject a fake aiwerk-signed
 * recipe into the cache during tests, since we can't talk to the real
 * bridge.aiwerk.ch without going through HTTP. The CatalogClient uses a baked
 * public key, so for verification tests we use skipSignatureVerify, and for
 * sig-check tests we exercise verifyRecipeSignature directly. */
function signRecipeForTest(recipe: Record<string, unknown>, privateKeyPem: string): {
  algorithm: "ed25519";
  publisherId: string;
  value: string;
  signedFields: string[];
  signedAt: string;
} {
  const key = createPrivateKey(privateKeyPem);
  const payload = Buffer.from(canonicalSignedPayload(recipe), "utf-8");
  const value = sign(null, payload, key).toString("base64");
  return {
    algorithm: "ed25519",
    publisherId: "test",
    value,
    signedFields: [...SIGNED_FIELDS],
    signedAt: new Date().toISOString(),
  };
}

function freshKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }) as string,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

const baseRecipe = (): Record<string, unknown> => ({
  id: "test",
  name: "Test",
  description: "A test recipe",
  transports: [{ type: "stdio", command: "echo", args: ["hi"] }],
  auth: { required: false, type: "none", envVars: [] },
  install: { method: "npx", package: "@test/test", version: "1.0.0" },
  metadata: { homepage: "https://example.com" },
});

// ─── verifyRecipeSignature ────────────────────────────────────────────────────

test("verifyRecipeSignature throws on missing signature", () => {
  const recipe = baseRecipe();
  assert.throws(
    () => verifyRecipeSignature(recipe as CatalogRecipe),
    /no signature/,
  );
});

test("verifyRecipeSignature throws on wrong algorithm", () => {
  const recipe = baseRecipe();
  (recipe as Record<string, unknown>).signature = {
    algorithm: "rsa",
    publisherId: "x",
    value: "abc",
    signedFields: [],
    signedAt: "2026-05-03T00:00:00Z",
  };
  assert.throws(
    () => verifyRecipeSignature(recipe as CatalogRecipe),
    /unsupported signature algorithm/,
  );
});

test("verifyRecipeSignature rejects a tampered recipe (real key, wrong subject)", () => {
  // Sign with a fresh key whose public key is NOT the baked AIWerk key.
  // Verification should fail because the baked public key cannot validate.
  const { privateKey } = freshKeyPair();
  const recipe = baseRecipe();
  (recipe as Record<string, unknown>).signature = signRecipeForTest(recipe, privateKey);
  assert.throws(
    () => verifyRecipeSignature(recipe as CatalogRecipe),
    /signature does not match/,
  );
});

// ─── CatalogClient cache + offline + signature-skip ──────────────────────────

test("CatalogClient.listCached returns empty array when cache dir missing", () => {
  const dir = mkTmp();
  try {
    const client = new CatalogClient({ cacheDir: join(dir, "recipes"), skipSignatureVerify: true });
    assert.deepEqual(client.listCached(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CatalogClient.getCached reads recipe from disk (no signature check)", () => {
  const dir = mkTmp();
  try {
    const cacheDir = join(dir, "recipes");
    mkdirSync(join(cacheDir, "todoist"), { recursive: true });
    writeFileSync(
      join(cacheDir, "todoist", "recipe.json"),
      JSON.stringify({ ...baseRecipe(), id: "todoist", name: "Todoist" }),
    );
    const client = new CatalogClient({ cacheDir, skipSignatureVerify: true });
    const cached = client.getCached("todoist");
    assert.equal(cached?.id, "todoist");
    assert.deepEqual(client.listCached(), ["todoist"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CatalogClient.resolve uses cached copy when network fails (skipSignatureVerify)", async () => {
  const dir = mkTmp();
  try {
    const cacheDir = join(dir, "recipes");
    mkdirSync(join(cacheDir, "todoist"), { recursive: true });
    writeFileSync(
      join(cacheDir, "todoist", "recipe.json"),
      JSON.stringify({ ...baseRecipe(), id: "todoist", name: "Todoist" }),
    );
    // Use a non-routable URL so the fetch fails fast
    const client = new CatalogClient({
      cacheDir,
      baseUrl: "http://127.0.0.1:1",
      skipSignatureVerify: true,
      staleDays: 0, // force "stale" so resolve goes to network first
    });
    const recipe = await client.resolve("todoist");
    assert.equal(recipe.id, "todoist");
    assert.equal(existsSync(join(cacheDir, "todoist", "recipe.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CatalogClient.resolve throws when offline AND no cache", async () => {
  const dir = mkTmp();
  try {
    const client = new CatalogClient({
      cacheDir: join(dir, "recipes"),
      baseUrl: "http://127.0.0.1:1",
      skipSignatureVerify: true,
    });
    await assert.rejects(
      () => client.resolve("nonexistent"),
      (err: unknown) => err instanceof CatalogError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CatalogClient.resolve verifies cached signature (default behavior)", async () => {
  const dir = mkTmp();
  try {
    const cacheDir = join(dir, "recipes");
    mkdirSync(join(cacheDir, "todoist"), { recursive: true });
    // No signature on cached file → verify must throw
    writeFileSync(
      join(cacheDir, "todoist", "recipe.json"),
      JSON.stringify({ ...baseRecipe(), id: "todoist", name: "Todoist" }),
    );
    const client = new CatalogClient({ cacheDir, baseUrl: "http://127.0.0.1:1" });
    await assert.rejects(
      () => client.resolve("todoist"),
      (err: unknown) => err instanceof CatalogSignatureError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
