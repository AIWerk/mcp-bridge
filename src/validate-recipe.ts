/**
 * Universal MCP Recipe Validator (spec v2.0, §7)
 */

// ─── Known categories (§3.1) ─────────────────────────────────────────────────
const KNOWN_CATEGORIES = new Set([
  "productivity",
  "development",
  "communication",
  "data",
  "database",
  "crm",
  "finance",
  "infrastructure",
  "analytics",
  "content",
  "search",
  "automation",
  "security",
  "ai",
  "other",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecipeTransport {
  type: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  framing?: string;
}

export interface RecipeInstall {
  method: string;
  package?: string;
  image?: string;
  repository?: string;
  buildCommand?: string;
  binary?: string;
  version?: string;
  preInstall?: string[];
  postInstall?: string[];
  platforms?: Record<string, unknown>;
}

export interface RecipeAuth {
  required?: boolean;
  type?: string;
  envVars?: string[];
  credentialsUrl?: string;
  instructions?: string;
  scopes?: string[];
  bootstrap?: string;
}

export interface RecipeMetadata {
  homepage?: string;
  license?: string;
  author?: string;
  tags?: string[];
  category?: string;
  languages?: string[];
  pricing?: string;
  maturity?: string;
  firstPublished?: string;
  lastVerified?: string;
  toolCount?: number;
  toolExamples?: Array<{ name: string; description: string }>;
}

export interface UniversalRecipe {
  schemaVersion?: unknown;
  id?: unknown;
  name?: unknown;
  description?: unknown;
  repository?: unknown;
  transports?: unknown;
  auth?: RecipeAuth;
  install?: RecipeInstall;
  metadata?: RecipeMetadata;
  capabilities?: unknown;
  [key: string]: unknown;
}

// ─── Validation result ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Convenience fields for success output */
  id?: string;
  toolCount?: number;
  primaryTransport?: string;
  installMethod?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract all ${VAR} references from a string */
function extractVarRefs(s: string): string[] {
  const matches = s.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g);
  return [...matches].map((m) => m[1]);
}

/** Recursively collect all ${VAR} references from an object's string values */
function collectVarRefs(obj: unknown, refs = new Set<string>()): Set<string> {
  if (typeof obj === "string") {
    for (const v of extractVarRefs(obj)) refs.add(v);
  } else if (Array.isArray(obj)) {
    for (const item of obj) collectVarRefs(item, refs);
  } else if (obj && typeof obj === "object") {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      collectVarRefs(val, refs);
    }
  }
  return refs;
}

// ─── Core validator ───────────────────────────────────────────────────────────

export function validateRecipe(recipe: UniversalRecipe): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── §7.1 Rule 1: schemaVersion === 2 ──────────────────────────────────────
  if (recipe.schemaVersion !== 2) {
    errors.push(
      `schemaVersion must be 2, got: ${JSON.stringify(recipe.schemaVersion)}`
    );
  }

  // ── §7.1 Rule 2: id format ─────────────────────────────────────────────────
  const id = recipe.id;
  if (typeof id !== "string" || id.length === 0) {
    errors.push("id is required and must be a non-empty string");
  } else {
    if (id.length < 2 || id.length > 64) {
      errors.push(`id must be 2-64 characters, got ${id.length}`);
    }
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(id)) {
      errors.push(
        `id must match ^[a-z0-9][a-z0-9-]*[a-z0-9]$ (lowercase alphanumeric with internal hyphens only), got: "${id}"`
      );
    }
  }

  // ── §7.1 Rule 3: name ──────────────────────────────────────────────────────
  const name = recipe.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    errors.push("name is required and must be a non-empty string");
  } else if (name.length > 128) {
    errors.push(`name must be max 128 chars, got ${name.length}`);
  }

  // ── §7.1 Rule 4: description ───────────────────────────────────────────────
  const desc = recipe.description;
  if (typeof desc !== "string" || desc.trim().length === 0) {
    errors.push("description is required and must be a non-empty string");
  } else if (desc.length > 512) {
    errors.push(`description must be max 512 chars, got ${desc.length}`);
  }

  // ── §7.1 Rule 5: repository or metadata.homepage ──────────────────────────
  const hasRepository =
    typeof recipe.repository === "string" && recipe.repository.trim().length > 0;
  const hasHomepage =
    typeof recipe.metadata?.homepage === "string" &&
    recipe.metadata.homepage.trim().length > 0;

  if (!hasRepository && !hasHomepage) {
    errors.push(
      "At least one of repository or metadata.homepage must be present"
    );
  }

  // ── §7.1 Rules 6 & 7: transports ──────────────────────────────────────────
  const transports = recipe.transports;
  if (!Array.isArray(transports) || transports.length === 0) {
    errors.push("transports must be a non-empty array");
  } else {
    let hasStdio = false;
    let allRemote = true;

    for (let i = 0; i < transports.length; i++) {
      const t = transports[i] as RecipeTransport;

      if (!t || typeof t !== "object") {
        errors.push(`transports[${i}]: must be an object`);
        continue;
      }

      if (typeof t.type !== "string" || t.type.trim().length === 0) {
        errors.push(`transports[${i}]: type is required`);
        continue;
      }

      const type = t.type;

      if (type === "stdio") {
        hasStdio = true;
        allRemote = false;
        if (typeof t.command !== "string" || t.command.trim().length === 0) {
          errors.push(`transports[${i}] (stdio): command is required`);
        }
      } else if (type === "sse" || type === "streamable-http") {
        if (typeof t.url !== "string" || t.url.trim().length === 0) {
          errors.push(`transports[${i}] (${type}): url is required`);
        }
      } else {
        errors.push(
          `transports[${i}]: unknown type "${type}", must be "stdio", "sse", or "streamable-http"`
        );
      }
    }

    // ── §7.1 Rule 9 & 10: install required for stdio ───────────────────────
    if (hasStdio) {
      if (!recipe.install) {
        errors.push(
          'install is required when any transport has type "stdio"'
        );
      } else if (
        typeof recipe.install.method !== "string" ||
        recipe.install.method.trim().length === 0
      ) {
        errors.push("install.method is required and must be a non-empty string");
      }
    }
    // allRemote → install is optional, nothing to check

    // ── §7.1 Rule 8: auth.envVars covers all ${VAR} references ────────────
    // Collect all ${VAR} refs from transports (env, headers, args, url)
    const transportVarRefs = new Set<string>();
    for (const t of transports as RecipeTransport[]) {
      if (t && typeof t === "object") {
        collectVarRefs(t.env, transportVarRefs);
        collectVarRefs(t.headers, transportVarRefs);
        collectVarRefs(t.args, transportVarRefs);
        if (typeof t.url === "string") collectVarRefs(t.url, transportVarRefs);
      }
    }

    if (transportVarRefs.size > 0) {
      const declaredEnvVars = new Set(recipe.auth?.envVars ?? []);
      const missing = [...transportVarRefs].filter(
        (v) => !declaredEnvVars.has(v)
      );
      if (missing.length > 0) {
        errors.push(
          `auth.envVars is missing these \${VAR} references found in transports: ${missing.join(", ")}`
        );
      }
    }
  }

  // ── §7.2 Warnings ──────────────────────────────────────────────────────────

  // Warning: metadata.lastVerified older than 90 days
  if (typeof recipe.metadata?.lastVerified === "string") {
    const lastVerified = new Date(recipe.metadata.lastVerified);
    if (!isNaN(lastVerified.getTime())) {
      const ageMs = Date.now() - lastVerified.getTime();
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
      if (ageMs > ninetyDaysMs) {
        warnings.push(
          `metadata.lastVerified is >90 days old (${recipe.metadata.lastVerified})`
        );
      }
    }
  }

  // Warning: unknown category
  if (
    typeof recipe.metadata?.category === "string" &&
    !KNOWN_CATEGORIES.has(recipe.metadata.category)
  ) {
    warnings.push(
      `metadata.category "${recipe.metadata.category}" is not in the known category list`
    );
  }

  // Warning: non-empty preInstall / postInstall
  if (
    Array.isArray(recipe.install?.preInstall) &&
    recipe.install.preInstall.length > 0
  ) {
    warnings.push(
      "Recipe contains preInstall commands - review before executing"
    );
  }
  if (
    Array.isArray(recipe.install?.postInstall) &&
    recipe.install.postInstall.length > 0
  ) {
    warnings.push(
      "Recipe contains postInstall commands - review before executing"
    );
  }

  // Warning: missing metadata.homepage when repository also absent
  if (!hasRepository && !hasHomepage) {
    // Already an error, skip duplicate warning
  } else if (!hasHomepage) {
    warnings.push(
      "metadata.homepage is missing - consider adding it for better discoverability"
    );
  }

  // Warning: maturity deprecated
  if (recipe.metadata?.maturity === "deprecated") {
    warnings.push("metadata.maturity is set to 'deprecated'");
  }

  // ── §2.9 Origin cross-check ────────────────────────────────────────────
  // If origin is "official", verify that metadata.author matches the npm package scope/maintainer hint.
  // This is a heuristic — not all packages have matching names — so it's a warning, not an error.
  const origin = (recipe.metadata as Record<string, unknown>)?.origin as string | undefined;
  const author = recipe.metadata?.author;
  const installPkg = recipe.install?.package;

  if (origin === "official" && typeof author === "string" && typeof installPkg === "string") {
    // Extract npm scope (e.g., "@cloudflare/mcp-server-cloudflare" → "cloudflare")
    const scopeMatch = installPkg.match(/^@([^/]+)\//);
    const scope = scopeMatch ? scopeMatch[1].toLowerCase() : null;
    const authorLower = author.toLowerCase();

    if (scope) {
      // Check if the scope relates to the author (heuristic: scope contains author or vice versa)
      // Known mappings for official packages where scope ≠ author name
      const knownOfficialMappings: Record<string, string[]> = {
        "playwright": ["microsoft"],
        "browserbasehq": ["browserbase"],
        "anthropic-ai": ["anthropic"],
        "twilio-alpha": ["twilio"],
        "perplexity-ai": ["perplexity"],
        "pinecone-database": ["pinecone"],
        "neondatabase": ["neon"],
        "doist": ["todoist"],
        "webflow-bot": ["webflow"],
      };
      const knownAliases = knownOfficialMappings[scope] ?? [];
      const scopeMatchesAuthor =
        authorLower.includes(scope) ||
        scope.includes(authorLower.replace(/[^a-z0-9]/g, "")) ||
        knownAliases.some(alias => authorLower.includes(alias));

      if (!scopeMatchesAuthor) {
        // Also check common patterns: "modelcontextprotocol" scope = Anthropic community, not official
        const communityScopes = new Set([
          "modelcontextprotocol",
        ]);
        if (communityScopes.has(scope)) {
          warnings.push(
            `origin is "official" but package scope @${scope} is a community/ecosystem scope — verify that ${author} actually maintains this package`
          );
        } else {
          warnings.push(
            `origin is "official" but npm scope @${scope} does not obviously match author "${author}" — verify npm maintainers`
          );
        }
      }
    } else {
      // No scope — unscoped packages are harder to verify, just note it
      warnings.push(
        `origin is "official" but package "${installPkg}" is unscoped — verify npm maintainers match "${author}"`
      );
    }
  }

  if (origin === "community" && typeof installPkg === "string") {
    // If community but package scope matches a well-known official org, warn
    const scopeMatch = installPkg.match(/^@([^/]+)\//);
    if (scopeMatch) {
      const scope = scopeMatch[1].toLowerCase();
      const officialScopes = new Set([
        "cloudflare", "stripe", "mongodb", "sentry", "datadog",
        "supabase", "notion-email", "slack", "linear", "playwright",
        "brave", "hubspot", "twilio-alpha", "perplexity-ai", "upstash",
        "pinecone-database", "grafana", "e2b", "browserbasehq", "brightdata",
        "letta-ai", "sanity", "contentful", "neondatabase",
        "shortcut", "webflow-bot", "doist", "replicate",
      ]);
      if (officialScopes.has(scope)) {
        warnings.push(
          `origin is "community" but package scope @${scope} looks like an official org — verify origin`
        );
      }
    }
  }

  // ── Build result ───────────────────────────────────────────────────────────
  const valid = errors.length === 0;

  const result: ValidationResult = { valid, errors, warnings };

  if (valid && typeof id === "string") {
    result.id = id;
    result.toolCount = recipe.metadata?.toolCount ?? 0;

    // Primary transport (first one)
    const firstTransport =
      Array.isArray(recipe.transports) && recipe.transports.length > 0
        ? (recipe.transports[0] as RecipeTransport).type
        : undefined;
    result.primaryTransport = firstTransport;
    result.installMethod = recipe.install?.method;
  }

  return result;
}

// ─── File loader ─────────────────────────────────────────────────────────────

export async function validateRecipeFile(
  filePath: string
): Promise<ValidationResult> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(filePath, "utf-8");
  let recipe: UniversalRecipe;
  try {
    recipe = JSON.parse(raw) as UniversalRecipe;
  } catch (e) {
    return {
      valid: false,
      errors: [`Failed to parse JSON: ${(e as Error).message}`],
      warnings: [],
    };
  }
  return validateRecipe(recipe);
}

// ─── Output formatting ────────────────────────────────────────────────────────

export function formatValidationResult(
  filePath: string,
  result: ValidationResult
): string {
  const lines: string[] = [];

  for (const w of result.warnings) {
    lines.push(`⚠️  Warning: ${w}`);
  }

  if (result.valid) {
    const toolCount = result.toolCount ?? 0;
    const transport = result.primaryTransport ?? "unknown";
    const method = result.installMethod ?? "remote";
    lines.push(
      `✅ Valid recipe: ${result.id} (${toolCount} tools, ${transport}, ${method})`
    );
  } else {
    lines.push(`❌ Invalid recipe: ${filePath}`);
    for (const err of result.errors) {
      lines.push(`   - ${err}`);
    }
  }

  return lines.join("\n");
}
