# Universal MCP Recipe Specification v2.0

**Status:** Draft  
**Date:** 2026-03-15  
**Authors:** Attila Bergsmann, Jerome (AIWerk)

## 1. Overview

A Universal MCP Recipe is a client-agnostic JSON document that describes how to install, configure, and run an MCP server. Recipes are consumed by **client adapters** (OpenClaw, Claude Desktop, Cursor, Cline, Windsurf, etc.) which translate the universal format into their native configuration.

### 1.1 Design Goals

- **Client-agnostic:** No recipe should reference a specific client's config format.
- **Self-contained:** A recipe contains everything needed to install and run the server.
- **Machine-readable:** Adapters can generate native configs automatically.
- **Human-readable:** Developers can understand and author recipes without tooling.
- **Extensible:** New fields can be added without breaking existing consumers.
- **Catalog-ready:** Rich metadata supports search, discovery, and quality signals.

### 1.1.1 Scope and Pragmatism

This spec is a **pragmatic interoperability format**, not an abstract universal standard. It is designed around the current MCP client ecosystem (OpenClaw, Claude Desktop, Cursor, Cline, etc.) and optimized for real-world install workflows. The format may evolve as the ecosystem matures. Where a decision was deferred, it is marked explicitly.

**What this spec covers:** Server definition (what to run, how to connect, what auth is needed) and install metadata (how to obtain the server binary/runtime).

**What this spec does NOT cover:** Runtime execution semantics (timeouts, healthchecks, reconnection, concurrency, caching). These are adapter/bridge runtime concerns and are specified in their respective adapter specs. The recipe describes *what* a server is; the adapter/bridge decides *how* to run it.

### 1.2 Architecture

The universal recipe lives in the **mcp-bridge core** and **mcp-catalog**. These packages have no knowledge of any specific client. Client-specific translation is handled by **adapter plugins** — separate packages that import recipes and output native configs.

```
┌─────────────────────────────────────────────────────────┐
│                    mcp-bridge (core)                     │
│  servers/           ← universal recipes (v2)             │
│  src/               ← bridge runtime (connect, route)    │
│  docs/              ← this spec                          │
│                                                          │
│  Knows: MCP protocol, transports, tool discovery         │
│  Does NOT know: OpenClaw, Claude Desktop, Cursor, etc.   │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌──▼────┐ ┌─────▼─────┐
       │  OpenClaw    │ │Claude │ │  Cursor   │
       │  Adapter     │ │Desktop│ │  Adapter  │
       │  (plugin)    │ │Adapter│ │  (CLI)    │
       └──────┬──────┘ └──┬────┘ └─────┬─────┘
              │            │            │
       openclaw.json  claude_desktop  .cursor/
                       _config.json   mcp.json

┌─────────────────────────────────────────────────────────┐
│                   mcp-catalog (hosted)                    │
│  Uses the same universal recipe format                   │
│  Exposes: catalog.search / catalog.info / catalog.install│
│  catalog.install returns recipe + optional adapter hints  │
└─────────────────────────────────────────────────────────┘
```

**Key principle:** The bridge core and catalog are the source of truth for recipes. They never generate client-specific output. Adapters are separate packages/plugins that consume recipes and handle all client-specific concerns (config format, env resolution, lifecycle).

## 2. Recipe Schema

### 2.1 File Structure

Each recipe is a directory containing:

```
servers/<server-id>/
├── recipe.json          # Required: the universal recipe
├── README.md            # Optional: human-readable docs
├── icon.svg             # Optional: server icon (SVG preferred, PNG accepted)
└── adapters/            # Optional: client-specific overrides
    ├── openclaw.json    # OpenClaw-specific config patches
    ├── claude-desktop.json
    └── cursor.json
```

### 2.2 recipe.json Schema

```jsonc
{
  // ─── Required ────────────────────────────────────────
  "schemaVersion": 2,                    // Always 2 for this spec
  "id": "todoist",                       // Unique kebab-case identifier
  "name": "Todoist",                     // Human-readable display name
  "description": "Task management with natural language",  // One-line summary

  // ─── Source (at least one required) ──────────────────
  // For open-source servers, use "repository".
  // For closed-source/SaaS/hosted servers, use metadata.homepage.
  // At least one of "repository" or metadata.homepage MUST be present.
  "repository": "https://github.com/doist/todoist-mcp",   // Source repo URL (optional)

  // ─── Transport ───────────────────────────────────────
  // At least one transport must be defined.
  // Adapters select the first transport they support.
  // Transport selection is NOT failover — if the selected transport
  // fails at runtime, the adapter handles retry/reconnect for that
  // same transport. See §2.3.1 for details.
  "transports": [
    {
      "type": "stdio",                   // "stdio" | "sse" | "streamable-http"
      "command": "npx",                  // Executable command
      "args": ["-y", "@doist/todoist-ai"],
      "env": {                           // Environment variables for the process
        "TODOIST_API_KEY": "${TODOIST_API_TOKEN}"
      }
    }
  ],

  // ─── Authentication ──────────────────────────────────
  "auth": {
    "required": true,
    "type": "api-key",                   // "api-key" | "oauth2" | "basic" | "bearer" | "custom" | "none"
    "envVars": ["TODOIST_API_TOKEN"],     // Env var names the user must provide
    "credentialsUrl": "https://app.todoist.com/app/settings/integrations/developer",
    "instructions": "Create an app integration and copy the API token."
  },

  // ─── Installation (optional for hosted transports) ───
  // Describes how to make the server binary/runtime available.
  // REQUIRED for stdio transports (something must be installed locally).
  // OPTIONAL for sse/streamable-http transports where the server is
  // already hosted remotely and no local process is needed.
  "install": {
    "method": "npx",                     // "npx" | "npm" | "pip" | "uvx" | "docker" | "binary" | "go" | "git"
    "package": "@doist/todoist-ai",      // Package identifier
    "version": "latest",                 // Version constraint (semver, "latest", or pinned)
    "preInstall": [],                    // Shell commands to run before install (rare, security-sensitive — see §9)
    "postInstall": [],                   // Shell commands to run after install (rare, security-sensitive — see §9)
    "platforms": {                       // Platform-specific overrides (optional)
      "win32": {
        "command": "npx.cmd"
      }
    }
  },

  // ─── Metadata (optional) ─────────────────────────────
  "metadata": {
    "homepage": "https://todoist.com/",
    "license": "MIT",
    "author": "Doist",
    "tags": ["productivity", "tasks", "project-management"],
    "category": "productivity",          // Primary category (see §3.1)
    "languages": ["en"],                 // ISO 639-1 codes
    "pricing": "freemium",              // "free" | "freemium" | "paid" | "byok" (bring your own key)
    "maturity": "stable",               // "experimental" | "beta" | "stable" | "deprecated"
    "firstPublished": "2025-06-15",
    "lastVerified": "2026-03-15",       // Date we last tested this recipe
    "toolCount": 27,                     // Known tool count (informational)
    "toolExamples": [                    // Example tools (helps discovery & smart routing)
      { "name": "create_task", "description": "Create a new task in Todoist" },
      { "name": "find_tasks", "description": "Search tasks by filter" }
    ]
  },

  // ─── Capabilities (optional) ─────────────────────────
  "capabilities": {
    "resources": false,                  // Server provides MCP resources
    "prompts": false,                    // Server provides MCP prompts
    "tools": true,                       // Server provides MCP tools
    "sampling": false                    // Server uses MCP sampling
  }
}
```

### 2.3 Transport Object

Each transport in the `transports` array follows this schema:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"stdio" \| "sse" \| "streamable-http"` | yes | MCP transport protocol |
| `command` | `string` | stdio only | Executable to run |
| `args` | `string[]` | — | Command arguments |
| `env` | `Record<string, string>` | — | Environment variables (supports `${VAR}` substitution) |
| `url` | `string` | sse/http only | Server endpoint URL |
| `headers` | `Record<string, string>` | — | HTTP headers (supports `${VAR}` substitution) |
| `framing` | `"auto" \| "lsp" \| "newline"` | — | stdio framing mode (default: auto) |

#### 2.3.1 Transport Selection vs. Failover

The `transports` array represents **alternative ways to run the same server**, not a failover chain. Adapters select one transport at install/config time based on what they support and what the environment provides (e.g., Docker available? Network access?).

**Selection is static** — it happens once at configuration time, not dynamically at runtime. If the selected transport fails during operation, the adapter handles reconnection for that same transport (see adapter-specific specs for retry behavior).

**Selection priority** (recommended for adapters):
1. `stdio` — most universal, works offline, isolated process
2. `streamable-http` — modern MCP HTTP transport
3. `sse` — legacy HTTP transport

Adapters MAY implement dynamic failover as an extension, but this is NOT required by this spec.

### 2.4 Install Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `method` | `string` | yes | Install method (see below) |
| `package` | `string` | depends | Package name/identifier |
| `version` | `string` | — | Version constraint |
| `image` | `string` | docker only | Docker image reference |
| `repository` | `string` | git only | Git clone URL |
| `buildCommand` | `string` | git only | Build command after clone |
| `binary` | `string` | binary only | Download URL template |
| `preInstall` | `string[]` | — | Pre-install shell commands |
| `postInstall` | `string[]` | — | Post-install shell commands |
| `platforms` | `Record<string, Partial<Transport>>` | — | Platform-specific overrides |

**Install methods:**

| Method | Description | Requires |
|--------|-------------|----------|
| `npx` | Run via npx (no persistent install) | `package` |
| `npm` | npm install -g | `package` |
| `pip` | pip install | `package` |
| `uvx` | Run via uvx (Python) | `package` |
| `docker` | Docker run | `image` |
| `binary` | Download prebuilt binary | `binary` |
| `go` | go install | `package` |
| `git` | Clone + build from source | `repository`, `buildCommand` |

#### 2.4.1 Runtime Prerequisites (reserved, optional)

The following fields are reserved for future use. They are NOT required in v2.0, but adapters and validators SHOULD preserve them if present:

```jsonc
{
  "install": {
    "method": "npm",
    "package": "@example/mcp-server",
    // Reserved fields (v2.1+):
    "prerequisites": {
      "node": ">=20",              // semver range
      "python": ">=3.11",
      "docker": true,              // Docker daemon required
      "os": ["linux", "darwin"],   // Supported platforms (Node.js os.platform() values)
      "arch": ["x64", "arm64"]     // Supported architectures
    },
    "healthcheck": "http://localhost:${PORT}/health",  // Post-install verification URL
    "verifyCommand": "npx @example/mcp-server --version"  // Post-install verification command
  }
}
```

These fields will be formally specified when real-world demand clarifies the exact needs. Recipe authors MAY include them now; adapters that don't understand them MUST ignore them (per §8).

**When `install` is optional:**

If all transports in the recipe are remote (`sse` or `streamable-http`) and require no local process, the `install` block MAY be omitted. The validator treats a missing `install` as valid when no `stdio` transport is defined.

### 2.5 Auth Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `required` | `boolean` | yes | Whether auth is needed |
| `type` | `string` | if required | Auth mechanism |
| `envVars` | `string[]` | if required | Env vars the user must set |
| `credentialsUrl` | `string` | — | Where to get credentials |
| `instructions` | `string` | — | Human-readable setup guide |
| `scopes` | `string[]` | oauth2 only | Required OAuth scopes |
| `bootstrap` | `string` | — | Install-time auth complexity (see below) |

**Auth bootstrap levels:**

| Level | Description | Example |
|-------|-------------|---------|
| `env-only` | User pastes a token/key into env. Fully automatable. | Todoist, Stripe, Tavily |
| `interactive` | Adapter handles auth flow (OAuth redirect, browser open). Semi-automatic. | Google APIs with OAuth2 |
| `manual` | User must manually configure auth outside the adapter (browser login, admin console setup, multi-step enrollment). | Atlassian with org-level permissions |

If `bootstrap` is omitted, adapters and catalog UIs SHOULD assume `env-only` when `type` is `api-key` or `bearer`, and `manual` when `type` is `oauth2` or `custom`.

**Auth types:**

| Type | Description |
|------|-------------|
| `api-key` | Single API key/token |
| `oauth2` | OAuth 2.0 flow (see §2.5.1) |
| `basic` | Username + password |
| `bearer` | Bearer token in HTTP header |
| `custom` | Non-standard (see `instructions`) |
| `none` | No auth needed |

#### 2.5.1 OAuth2 Considerations

OAuth2 is the most complex auth type. This spec intentionally limits its scope to **declaring requirements** (scopes, credentials URL, instructions). The actual OAuth2 flow — authorization redirect, token exchange, refresh token storage — is **adapter-specific** and varies significantly between clients.

Adapters implementing OAuth2 support SHOULD:
- Handle the authorization code flow (PKCE recommended)
- Store refresh tokens securely in their native secrets store
- Auto-refresh expired access tokens
- Document their OAuth2 implementation in the adapter spec

A full OAuth2 integration spec may be published separately as demand arises.

### 2.6 Environment Variable Substitution

All string values in `env`, `headers`, `args`, and `url` support `${VAR_NAME}` substitution. The adapter resolves these from its native env/secrets store:

- **OpenClaw:** `~/.openclaw/.env` + shell env + `pass`
- **Claude Desktop:** system env
- **Cursor:** `.env` in project root + system env
- etc.

Variables are **never** stored in the recipe — only their names.

### 2.7 Upstream Package Integrity

For verified recipes, the `quality` field in the **catalog overlay** (see §2.8) contains a SHA-512 hash of the pinned package at the time of audit. Adapters MAY verify this hash at install time.

```json
{
  "verified": true,
  "verifiedAt": "2026-03-15T10:00:00Z",
  "upstreamHash": "sha512-a7f3b2c9d8e1f4...",
  "auditedVersion": "1.2.3"
}
```

### 2.8 Quality Signals — Catalog Overlay

Quality signals (`verified`, `badge`, `upstreamHash`, etc.) are **NOT part of the recipe itself**. They are managed by the catalog as a separate overlay:

```
Recipe (author's responsibility):
  recipe.json — id, name, description, transports, auth, install, metadata, capabilities

Catalog overlay (catalog's responsibility):
  quality.json — verified, verifiedAt, badge, upstreamHash, auditedVersion
  promotion.json — promoted, promotedBy, affiliateUrl, featuredWeight
```

**Rationale:** The recipe author describes how to run a server. The catalog operator decides trust signals. Mixing these in one file creates ambiguous ownership — an author could self-declare `"verified": true`.

When the catalog serves a recipe (via `catalog.info`), it merges the overlay into the response. The raw `recipe.json` in `servers/` never contains quality or promotion fields.

## 3. Taxonomy

### 3.1 Categories

Categories are an **open enum with known values**. The validator accepts any lowercase kebab-case string as a category, but emits a warning for values not in the known list. This allows organic growth while keeping discoverability.

**Known categories:**

| Category | Examples |
|----------|---------|
| `productivity` | Todoist, Linear, Notion, Miro |
| `development` | GitHub, GitLab, Sentry, Datadog |
| `communication` | Slack, Discord, Email |
| `data` | PostgreSQL, MongoDB, Elasticsearch |
| `finance` | Stripe, Wise, Binance |
| `infrastructure` | Hetzner, AWS, Docker |
| `analytics` | Plausible, Mixpanel, Google Analytics |
| `content` | WordPress, Contentful, Sanity |
| `search` | Tavily, Brave, Google |
| `automation` | Apify, Zapier, n8n |
| `security` | Vault, SIEM, auth providers |
| `ai` | Hugging Face, Replicate, OpenAI |
| `other` | Anything that doesn't fit above |

New categories MAY be added to the known list in minor spec revisions. Unknown categories are stored as-is and displayed normally — they just trigger a validator warning.

### 3.2 Tags

Free-form, lowercase, kebab-case. Used for search/filtering beyond category.

## 4. Client Adapter Specification

### 4.1 Adapter Contract

Every adapter MUST implement:

```typescript
interface RecipeAdapter {
  /** Adapter identifier (e.g., "openclaw", "claude-desktop") */
  id: string;
  
  /** Convert a universal recipe to native config format */
  toNativeConfig(recipe: UniversalRecipe): NativeConfig;
  
  /** Import a native config into a universal recipe (best-effort) */
  fromNativeConfig(native: NativeConfig): UniversalRecipe;
  
  /** Install the server (resolve env vars, run install steps) */
  install(recipe: UniversalRecipe, options: InstallOptions): Promise<void>;
  
  /** Uninstall the server */
  uninstall(recipe: UniversalRecipe): Promise<void>;
}
```

> **Note:** All JSON examples in §4.2–4.5 use JSONC (JSON with Comments) for illustration. Actual config files are plain JSON — comments are not valid.

### 4.2 OpenClaw Adapter

Translates recipe -> OpenClaw plugin config:

```jsonc
// Universal recipe transport
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@doist/todoist-ai"],
  "env": { "TODOIST_API_KEY": "${TODOIST_API_TOKEN}" }
}

// -> OpenClaw native config (openclaw.json)
{
  "plugins": {
    "entries": {
      "openclaw-mcp-bridge": {
        "config": {
          "servers": {
            "todoist": {
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "@doist/todoist-ai"],
              "env": { "TODOIST_API_KEY": "${TODOIST_API_TOKEN}" }
            }
          }
        }
      }
    }
  }
}
```

### 4.3 Claude Desktop Adapter

Translates recipe -> `claude_desktop_config.json`:

```jsonc
// -> Claude Desktop native config
{
  "mcpServers": {
    "todoist": {
      "command": "npx",
      "args": ["-y", "@doist/todoist-ai"],
      "env": { "TODOIST_API_KEY": "actual-token-value" }
    }
  }
}
```

**Note:** Claude Desktop requires actual values in env (no `${VAR}` substitution). The adapter must resolve variables before writing.

### 4.4 Cursor Adapter

Translates recipe -> `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "todoist": {
      "command": "npx",
      "args": ["-y", "@doist/todoist-ai"],
      "env": { "TODOIST_API_KEY": "actual-token-value" }
    }
  }
}
```

### 4.5 Adapter Overrides

When a server needs client-specific tweaks, the `adapters/` directory contains override files.

Example — `servers/github/adapters/openclaw.json`:

```json
{
  "transport": "stdio",
  "command": "docker",
  "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", 
           "ghcr.io/github/github-mcp-server"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_MCP_TOKEN}" }
}
```

Adapters MUST deep-merge the override with the translated recipe output using these rules:
- **Objects:** recursive merge (override keys win)
- **Arrays:** full replacement (override array replaces base array entirely)
- **Scalars:** override wins

This means `args` in an override **replaces** the recipe's `args`, it does not concatenate. Same for `envVars` and other array fields.

## 5. Migration from Schema v1

### 5.1 Mapping

| v1 field | v2 field |
|----------|----------|
| `schemaVersion: 1` | `schemaVersion: 2` |
| `name` | `id` + `name` (split: id=kebab-case, name=display) |
| `description` | `description` |
| `transport` | `transports[0].type` |
| `command` | `transports[0].command` |
| `args` | `transports[0].args` |
| `env` | `transports[0].env` |
| `url` | `transports[0].url` |
| `headers` | `transports[0].headers` |
| `authRequired` | `auth.required` |
| `credentialsUrl` | `auth.credentialsUrl` |
| `homepage` | `metadata.homepage` |

### 5.2 Automatic Migration

The catalog and bridge MUST support both v1 and v2 recipes during a transition period. A migration utility converts v1 -> v2:

```bash
npx @aiwerk/mcp-bridge migrate-recipe servers/todoist/config.json
# -> writes servers/todoist/recipe.json (v2)
```

### 5.3 env_vars File Deprecation

The separate `env_vars` file is replaced by `auth.envVars` in the recipe. The migration tool reads `env_vars` and inlines it.

## 6. Catalog Integration

### 6.1 Index File

The `index.json` at the catalog root aggregates all recipes:

The index is a catalog-generated aggregation that includes both recipe metadata and catalog overlay fields (e.g., `verified`, `badge`). This is not an inconsistency with §2.8 — the index is a catalog output, not a raw recipe.

```json
{
  "schemaVersion": 2,
  "generatedAt": "2026-03-15T10:00:00Z",
  "recipes": {
    "todoist": {
      "name": "Todoist",
      "description": "Task management with natural language",
      "category": "productivity",
      "tags": ["tasks", "project-management"],
      "auth": { "required": true, "type": "api-key" },
      "transports": ["stdio"],
      "install": { "method": "npx" },
      "maturity": "stable",
      "verified": false,
      "toolCount": 27
    }
  }
}
```

### 6.2 MCP Catalog Server Tools

The catalog exposes itself as an MCP server with these tools:

| Tool | Description |
|------|-------------|
| `catalog.search` | Full-text + tag search across recipes |
| `catalog.info` | Detailed recipe info by id (includes catalog overlay) |
| `catalog.install` | Generate native config for a given client adapter |
| `catalog.list` | List recipes by category/tag |
| `catalog.adapters` | List supported client adapters |

### 6.3 Monetization Fields (Future — Phase 4)

Reserved fields stored in the catalog overlay (NOT in recipe.json):

```jsonc
// catalog overlay: promotion.json
{
  "promoted": false,          // Sponsored/promoted recipe
  "promotedBy": null,         // Sponsor name
  "affiliateUrl": null,       // Referral link
  "featuredWeight": 0         // Boost in smart filter (0 = neutral)
}
```

**Rule:** Promoted recipes MUST be visibly labeled. The exact ranking algorithm for `featuredWeight` is deferred to the Phase 4 monetization spec — it will define how boosting interacts with relevance scoring.

## 7. Validation

### 7.1 Required Field Validation

A recipe is valid if:
1. `schemaVersion` === 2
2. `id` matches `^[a-z0-9][a-z0-9-]*[a-z0-9]$` (2-64 chars, no leading/trailing hyphens)
3. `name` is a non-empty string (max 128 chars)
4. `description` is a non-empty string (max 512 chars)
5. At least one of `repository` or `metadata.homepage` is present
6. `transports` has at least one entry
7. Each transport has `type`, and `command` (stdio) or `url` (sse/http)
8. `auth.envVars` lists all `${VAR}` references found in transports
9. If any transport has `type: "stdio"`, `install` MUST be present with a valid `method`
10. If all transports are remote (`sse`/`streamable-http`), `install` is optional

### 7.2 CLI Validator

```bash
npx @aiwerk/mcp-bridge validate-recipe servers/todoist/recipe.json
# Valid recipe: todoist (27 tools, stdio, npx)
# Warning: metadata.lastVerified is >90 days old
```

The validator MUST emit warnings (not errors) for:
- `metadata.lastVerified` older than 90 days
- `metadata.category` not in the known category list (see §3.1)
- Non-empty `preInstall` or `postInstall` arrays: `Recipe contains preInstall/postInstall commands - review before executing`
- Missing `metadata.homepage` when `repository` is also absent
- `metadata.maturity` set to `deprecated`

### 7.3 ID Format Examples

| ID | Valid | Reason |
|----|-------|--------|
| `todoist` | yes | |
| `google-maps` | yes | |
| `a1` | yes | Minimum 2 chars |
| `my-server-2` | yes | |
| `a-` | **no** | Trailing hyphen |
| `-a` | **no** | Leading hyphen |
| `a` | **no** | Below minimum 2 chars |
| `My-Server` | **no** | Uppercase not allowed |

## 8. Versioning & Compatibility

- **Schema version** increments only for breaking changes.
- **Minor additions** (new optional fields) do NOT increment the version.
- Consumers MUST ignore unknown fields.
- The `schemaVersion` field is required and MUST be checked before parsing.

## 9. Security Considerations

### 9.1 Credential Handling

- Recipes MUST NOT contain actual secrets, tokens, or credentials.
- `${VAR}` references are names only — resolution is adapter-specific.

### 9.2 preInstall/postInstall Commands

These fields execute arbitrary shell commands and represent a **supply-chain remote code execution surface**. The following policies apply:

**Catalog policy (catalog-hosted recipes):**
- Recipes in the official catalog MUST NOT contain non-empty `preInstall`/`postInstall` arrays unless explicitly approved through the catalog's trust review process.
- The catalog SHOULD reject recipe submissions with non-empty arrays unless the submitter has a verified publisher status.

**Adapter policy:**
- Adapters MUST warn the user before executing any pre/post install commands.
- In non-interactive environments (CI, headless, automated installs), adapters MUST hard-fail if pre/post install commands are present, unless explicitly opted in via a flag (e.g., `--allow-scripts`).
- All executed commands MUST be logged with timestamp, recipe id, and exit code for auditability.

**Validator policy:**
- The CLI validator MUST emit a warning for non-empty arrays (see §7.2).

### 9.3 Package Integrity

- The `quality.upstreamHash` (in catalog overlay) provides integrity verification but is NOT a substitute for code audit.
- Recipe signatures (Ed25519) are specified separately in the Catalog Security Spec.

## 10. Future Work (deferred from v2.0)

The following topics are recognized as valuable but intentionally deferred. They will be addressed in future spec revisions when real-world usage provides clearer requirements.

### 10.1 Capability Registry (v2.1+)

For advanced smart routing and agent-driven discovery, recipes may need richer tool metadata beyond `toolExamples`:

- **Operation types:** `read`, `write`, `search`, `execute`
- **Side effects:** `none`, `external-write`, `billing-impact`
- **Input shape hints:** accepts geo coordinates, free text, file/blob, structured data
- **Supported domains:** CRM, e-commerce, DevOps, etc.

This would transform the catalog from a curated app directory into a runtime-usable capability registry. Deferred because the schema needs to be driven by actual smart routing implementation, not speculation.

### 10.2 Runtime Execution Hints (v2.1+)

Some server properties affect how a bridge runtime should manage them:

- **Stateless vs. stateful** process (can it be restarted freely?)
- **Singleton vs. concurrent-safe** (can multiple instances run?)
- **Long-running background** vs. on-demand spawn
- **Idempotency hints** per tool
- **Server-level timeout overrides** (startup, request)

These are bridge runtime concerns (see §1.1.1) but could benefit from recipe-level hints. Deferred until the bridge runtime spec matures.

### 10.3 Enhanced Adapter Override Mechanism (v2.1+)

The current array-replace merge semantics (§4.5) are simple but blunt. A future revision may introduce:

- JSON Patch (RFC 6902) support for fine-grained overrides
- Conditional overrides (e.g., "if Docker available, use this transport")
- Platform-conditional overrides beyond `install.platforms`

Deferred because the current model covers all existing recipes without issues.

### 10.4 Full OAuth2 Integration Spec

A standalone spec for OAuth2 credential bootstrap, token storage, and refresh across adapters. See §2.5.1.

## Appendix A: Full Example — Atlassian (Complex, stdio)

```json
{
  "schemaVersion": 2,
  "id": "atlassian",
  "name": "Atlassian (Confluence + Jira)",
  "description": "Confluence wiki and Jira project management - search, create, update pages and issues",
  "repository": "https://github.com/sooperset/mcp-atlassian",
  
  "transports": [
    {
      "type": "stdio",
      "command": "uvx",
      "args": ["mcp-atlassian"],
      "env": {
        "CONFLUENCE_URL": "${CONFLUENCE_URL}",
        "CONFLUENCE_USERNAME": "${CONFLUENCE_USERNAME}",
        "CONFLUENCE_API_TOKEN": "${CONFLUENCE_API_TOKEN}",
        "JIRA_URL": "${JIRA_URL}",
        "JIRA_USERNAME": "${JIRA_USERNAME}",
        "JIRA_API_TOKEN": "${JIRA_API_TOKEN}"
      }
    }
  ],

  "auth": {
    "required": true,
    "type": "api-key",
    "envVars": [
      "CONFLUENCE_URL", "CONFLUENCE_USERNAME", "CONFLUENCE_API_TOKEN",
      "JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"
    ],
    "credentialsUrl": "https://id.atlassian.com/manage-profile/security/api-tokens",
    "instructions": "Create an API token at the Atlassian account settings. Set CONFLUENCE_URL and JIRA_URL to your instance URLs (e.g., https://yourcompany.atlassian.net/wiki and https://yourcompany.atlassian.net)."
  },

  "install": {
    "method": "uvx",
    "package": "mcp-atlassian",
    "version": "latest"
  },

  "metadata": {
    "homepage": "https://github.com/sooperset/mcp-atlassian",
    "license": "MIT",
    "author": "sooperset",
    "tags": ["wiki", "project-management", "confluence", "jira", "atlassian"],
    "category": "productivity",
    "pricing": "byok",
    "maturity": "stable",
    "toolCount": 72,
    "toolExamples": [
      { "name": "search_confluence", "description": "Search Confluence pages by CQL query" },
      { "name": "create_jira_issue", "description": "Create a new Jira issue" }
    ]
  },

  "capabilities": {
    "resources": true,
    "prompts": false,
    "tools": true,
    "sampling": false
  }
}
```

## Appendix B: Full Example — Apify (Hosted HTTP, no install block)

```json
{
  "schemaVersion": 2,
  "id": "apify",
  "name": "Apify",
  "description": "Web scraping and automation platform with 3000+ ready-made actors",
  "repository": "https://github.com/apify/apify-mcp-server",
  
  "transports": [
    {
      "type": "streamable-http",
      "url": "https://mcp.apify.com/mcp",
      "headers": {
        "Authorization": "Bearer ${APIFY_TOKEN}"
      }
    }
  ],

  "auth": {
    "required": true,
    "type": "bearer",
    "envVars": ["APIFY_TOKEN"],
    "credentialsUrl": "https://console.apify.com/settings/integrations",
    "instructions": "Copy your API token from Apify Console > Settings > Integrations."
  },

  "metadata": {
    "homepage": "https://apify.com/",
    "license": "Apache-2.0",
    "author": "Apify",
    "tags": ["scraping", "automation", "web", "crawling"],
    "category": "automation",
    "pricing": "freemium",
    "maturity": "stable"
  }
}
```

Note: No `install` block — the server is hosted remotely, no local process needed.

## Appendix C: Full Example — Multi-Transport (stdio + HTTP alternative)

```json
{
  "schemaVersion": 2,
  "id": "example-dual",
  "name": "Example Dual Transport Server",
  "description": "A server available both locally and as a hosted service",
  
  "transports": [
    {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": { "API_KEY": "${EXAMPLE_API_KEY}" }
    },
    {
      "type": "streamable-http",
      "url": "https://mcp.example.com/v1",
      "headers": { "Authorization": "Bearer ${EXAMPLE_API_KEY}" }
    }
  ],

  "auth": {
    "required": true,
    "type": "api-key",
    "envVars": ["EXAMPLE_API_KEY"],
    "credentialsUrl": "https://example.com/settings/api"
  },

  "install": {
    "method": "npx",
    "package": "@example/mcp-server"
  },

  "metadata": {
    "homepage": "https://example.com/",
    "category": "other"
  }
}
```

An adapter that only supports HTTP would skip the first transport and use the second. An adapter that prefers local execution would use the first.
