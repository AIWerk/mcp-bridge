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

The **mcp-catalog** is the single source of truth for recipes. The **mcp-bridge** fetches and caches recipes locally from the catalog. Client-specific translation is handled by **adapter plugins** — separate packages that consume recipes and output native configs.

```
┌─────────────────────────────────────────────────────────┐
│  awesome-mcp-recipes (GitHub)   — Layer 1                │
│  Community intake, auto-tested (Tier 1 + 1.5)           │
│  Open submissions, "Listed" status                       │
└──────────────────────────┬──────────────────────────────┘
                           │ curation
                           ▼
┌─────────────────────────────────────────────────────────┐
│  mcp-catalog (catalog.aiwerk.ch) — Layer 2               │
│  Curated, signed, verified recipes                       │
│  Single source of truth                                  │
│  Exposes: catalog.search / catalog.info / catalog.download│
└──────────────────────────┬──────────────────────────────┘
                           │ fetch + cache
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    mcp-bridge (core) — Layer 3            │
│  Local recipe cache (fetched from catalog)               │
│  Bootstrap: top 15 popular recipes on first run          │
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
```

**Key principles:**
- The **catalog** is the source of truth for recipes. Recipes are curated, tested (Tier 1–3), and signed.
- The **bridge** caches recipes locally for offline operation. It does not ship bundled recipes — it fetches them from the catalog.
- **Adapters** consume recipes and handle all client-specific concerns (config format, env resolution, lifecycle).
- The **awesome-mcp-recipes** repo is the community intake funnel where anyone can submit recipes.

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
    "subcategory": "task-management",    // Optional refinement within category (see §3.1.1)
    "origin": "official",               // "official" | "community" | "aiwerk" (see §3.3)
    "countries": ["global"],             // ISO 3166-1 alpha-2 codes or "global" (see §3.4)
    "languages": ["en"],                 // ISO 639-1 codes
    "audience": "business",             // "developer" | "business" | "consumer" | "general" (see §3.5)
    "selfHosted": false,                // Can be run locally without external dependencies
    "sideEffects": "read-write",        // "read-only" | "read-write" | "billing-impact" (see §3.6)
    "pricing": "freemium",              // "free" | "freemium" | "paid" | "byok" (bring your own key)
    "maturity": "stable",               // "experimental" | "beta" | "stable" | "deprecated"
    "firstPublished": "2025-06-15",
    "lastVerified": "2026-03-15",       // Date we last tested this recipe
    "toolCount": 27,                     // Known tool count (informational)
    "toolExamples": [                    // Example tools (helps discovery & smart routing)
      { "name": "create_task", "description": "Create a new task in Todoist" },
      { "name": "find_tasks", "description": "Search tasks by filter" }
    ],
    "resourceExamples": [               // Example MCP resources (optional, for servers with capabilities.resources=true)
      { "uri": "todoist://projects", "description": "List of all projects" },
      { "uri": "todoist://today", "description": "Today's tasks" }
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
| `auth` | `object` | — | Transport-level auth config (see §2.5.1 for OAuth2 details) |
| `framing` | `"auto" \| "lsp" \| "newline"` | — | stdio framing mode (default: auto) |

**Transport auth types** (for `auth` field):

| Auth config | Description |
|-------------|-------------|
| `{ type: "bearer", token: "..." }` | Static bearer token (supports `${VAR}`) |
| `{ type: "header", headers: { ... } }` | Custom auth headers (supports `${VAR}`) |
| `{ type: "oauth2", clientId, clientSecret, tokenUrl, scopes?, audience? }` | OAuth2 Client Credentials (see §2.5.1) |

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

#### 2.5.1 OAuth2 Details

OAuth2 is the most complex auth type. Recipes declare both **high-level requirements** (in `auth`) and **runtime configuration** (in transport `auth`).

**Recipe-level** (§2.5 `auth`): declares what the user needs — `type: "oauth2"`, `envVars`, `scopes`, `credentialsUrl`, `bootstrap` level. This is for install-time UX.

**Transport-level** (§2.3 `transports[].auth`): declares runtime OAuth2 config for the bridge/adapter. This enables **automatic token management** without adapter-specific code.

Transport-level OAuth2 config:

```json
{
  "transports": [{
    "type": "streamable-http",
    "url": "https://provider.com/mcp",
    "auth": {
      "type": "oauth2",
      "clientId": "${CLIENT_ID}",
      "clientSecret": "${CLIENT_SECRET}",
      "tokenUrl": "https://provider.com/oauth/token",
      "scopes": ["read", "write"],
      "audience": "https://api.provider.com"
    }
  }]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"oauth2"` | yes | Auth mechanism |
| `clientId` | `string` | yes | OAuth2 client ID (may use `${VAR}` env substitution) |
| `clientSecret` | `string` | yes | OAuth2 client secret (may use `${VAR}` env substitution) |
| `tokenUrl` | `string` | yes | Token endpoint URL |
| `scopes` | `string[]` | no | Requested scopes (space-joined in token request) |
| `audience` | `string` | no | Audience parameter (some providers require it) |

**Runtime behavior** (bridge/adapter):
1. On first tool call: POST `tokenUrl` with `grant_type=client_credentials`, `client_id`, `client_secret`, optional `scope` and `audience`
2. Cache the `access_token` (keyed by `tokenUrl + clientId`)
3. Include `Authorization: Bearer <token>` on all MCP requests
4. If `expires_in` is returned, refresh token before expiry (with 60s buffer)
5. On HTTP 401: invalidate cached token, re-acquire, retry the request **once**
6. If `refresh_token` is returned, use it for renewal before falling back to full client_credentials grant

**Relationship between recipe-level and transport-level auth:**
- Recipe-level `auth` tells the installer/user **what credentials to obtain**
- Transport-level `auth` tells the bridge **how to use those credentials at runtime**
- Both may coexist in the same recipe — they serve different audiences

Adapters and bridges SHOULD support at minimum:
- Client Credentials grant (`grant_type=client_credentials`)
- Token caching with expiry-aware refresh
- Automatic 401 retry (single attempt)

Authorization Code flow (PKCE) is adapter-specific and outside the scope of this spec. Adapters implementing it SHOULD document their flow in the adapter spec.

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

### 2.9 Verification — Tier Testing

Recipes MAY include a `metadata.verification` block that records the outcome of the catalog operator's test pipeline. Unlike quality overlay signals (§2.8), verification results are **written by the catalog operator** (not the recipe author) and are **included in the signed recipe** to provide tamper-proof test provenance.

#### 2.9.1 Tier definitions

| Tier | What it tests | Gate |
|------|--------------|------|
| **Tier 1** | Recipe JSON schema validity + Ed25519 signature | **Required** — recipe cannot enter catalog without Tier 1 pass |
| **Tier 2** | Server actually starts (`initialize` + `tools/list` via MCP protocol) | **Soft gate** — `skip` is acceptable when auth is required and no test credentials are available; `fail` (for non-auth reasons) means the recipe is **excluded** from the catalog |

#### 2.9.2 Schema

```json
"metadata": {
  "verification": {
    "tier1": "pass",
    "tier2": "pass" | "skip",
    "tier2Tools": 22,
    "tier2Date": "2026-03-25",
    "tier2Reason": "auth-required",
    "tier2Note": "remote-reachable"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `tier1` | `"pass"` | Always `"pass"` — failed Tier 1 recipes are never admitted |
| `tier2` | `"pass"` \| `"skip"` | Never `"fail"` — Tier 2 failures (non-auth) are excluded from catalog |
| `tier2Tools` | `number` | Tool count returned by `tools/list` (only when `tier2 = "pass"`) |
| `tier2Date` | `string` (ISO date) | Date of last successful Tier 2 test |
| `tier2Reason` | `string` | Why Tier 2 was skipped: `"auth-required"`, `"draft"` |
| `tier2Note` | `string` | Additional context, e.g. `"remote-reachable"` for HTTP endpoint ping |
| `depAudit` | `"clean"` \| `"has-advisories"` \| `"not-applicable"` \| `"skip"` | Dependency vulnerability scan result (npm audit or pip-audit) |
| `depAuditDate` | `string` (ISO date) | Date of last dependency audit |
| `depAuditNote` | `string` | Human-readable explanation, especially for `has-advisories` (e.g. "3 high in upstream dependencies — not in recipe code") |

#### 2.9.3 Dependency Audit

The catalog operator runs dependency vulnerability scans on each recipe's package to detect known CVEs:
- **npm packages** → `npm audit` (GitHub Advisory Database)
- **Python packages** → `pip-audit` (PyPI/OSV vulnerability database)

| Value | Meaning |
|-------|---------|
| `"clean"` | No known vulnerabilities |
| `"has-advisories"` | Upstream dependency CVEs exist — NOT in recipe code. `npmAuditNote` explains the issue. |
| `"not-applicable"` | No npm package (remote-only, uvx/Python, git-only servers) |
| `"skip"` | Dependency resolution failed or audit could not run |

**Important:** `has-advisories` does NOT mean the recipe is malicious. It means the upstream MCP server package uses dependencies with known CVEs. The recipe itself is a JSON config file with no executable code. The note field MUST clarify this distinction.

#### 2.9.4 Admission policy

1. **Tier 1 fail** → recipe is rejected, never enters catalog
2. **Tier 2 fail** (server crashes, protocol error, not auth-related) → recipe is rejected
3. **Tier 2 skip** (auth required, no test credentials) → recipe is admitted with `"tier2": "skip"`
4. **Tier 2 pass** (with or without auth, server responds correctly) → recipe is admitted with `"tier2": "pass"`

The catalog **never contains** a recipe with `"tier2": "fail"`. If a previously passing recipe fails on re-test, it SHOULD be set to `maturity: "deprecated"` or removed.

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

#### 3.1.1 Subcategories

Optional refinement within a category. Like categories, subcategories are an open enum with known values. The validator accepts any lowercase kebab-case string.

**Known subcategories (by category):**

| Category | Subcategories |
|----------|---------------|
| `productivity` | `task-management`, `notes`, `calendar`, `whiteboard`, `project-management` |
| `development` | `version-control`, `ci-cd`, `monitoring`, `error-tracking`, `code-review` |
| `communication` | `email`, `chat`, `sms`, `video`, `notifications` |
| `data` | `relational`, `nosql`, `search-engine`, `file-storage`, `data-warehouse` |
| `finance` | `payments`, `invoicing`, `banking`, `crypto`, `accounting` |
| `infrastructure` | `cloud`, `dns`, `cdn`, `containers`, `serverless` |
| `analytics` | `web-analytics`, `product-analytics`, `bi`, `seo` |
| `content` | `cms`, `headless-cms`, `media`, `documents` |
| `search` | `web-search`, `ai-search`, `site-search` |
| `automation` | `scraping`, `workflow`, `rpa`, `iot` |
| `security` | `auth`, `secrets`, `scanning`, `compliance` |
| `ai` | `inference`, `training`, `embeddings`, `image-generation` |

### 3.2 Tags

Free-form, lowercase, kebab-case. Used for search/filtering beyond category.

### 3.3 Origin

Indicates who created and maintains the MCP server:

| Value | Description |
|-------|-------------|
| `official` | Created by the service provider themselves (e.g., Stripe's own MCP server) |
| `community` | Created by a third-party developer, not officially endorsed |
| `aiwerk` | Created and maintained by AIWerk |

The catalog MAY display origin prominently — `official` servers carry implicit trust. The origin field is informational; trust verification is handled by the catalog's badge/verification system (see §2.8).

### 3.4 Countries

ISO 3166-1 alpha-2 country codes indicating where the server/service is relevant. Use `"global"` for services without geographic restrictions.

**Examples:**
- `["global"]` — Todoist, Stripe (works everywhere)
- `["CH"]` — Bexio, PostFinance, QR-Rechnung (Swiss-specific)
- `["CH", "DE", "AT"]` — DACH region services
- `["EU"]` — EU-wide services (GDPR-compliant tools, EU banking)

Agents and catalog search SHOULD use the user's country/region to boost relevant results. A Swiss user searching for "invoicing" should see Bexio before QuickBooks.

### 3.5 Audience

Who is the primary user of this server:

| Value | Description |
|-------|-------------|
| `developer` | Requires technical knowledge (GitHub, Sentry, Docker) |
| `business` | For business users/teams (CRM, invoicing, marketing) |
| `consumer` | For end users (smart home, personal finance, media) |
| `general` | No specific audience |

### 3.6 Side Effects

What kind of changes can this server make:

| Value | Description |
|-------|-------------|
| `read-only` | Only reads data, never modifies anything |
| `read-write` | Can create, update, or delete data |
| `billing-impact` | Can trigger financial transactions (payments, subscriptions) |

Agents SHOULD warn users before invoking tools from servers with `billing-impact` side effects.

### 3.7 Catalog Enrichment (Dynamic Metadata)

Not all metadata needs to live in the recipe. The catalog can **enrich** recipes with computed or curated metadata at serve time, without modifying the original `recipe.json`.

> **Authorship rule:** If the recipe author provided a value, it is authoritative by default. The catalog enrichment only fills in **missing** fields. A catalog curator MAY override author-provided values via an explicit curated overlay, but this must be a deliberate editorial action — not automatic.

#### 3.7.1 Problem

As the catalog grows, new metadata dimensions will be needed (e.g., auth summary, popularity score, compatibility flags). Updating every recipe manually for each new dimension is unsustainable at 100+ recipes.

#### 3.7.2 Solution: Enrichment Overlay

The catalog maintains an **enrichment overlay** per recipe, separate from the recipe itself:

```
Recipe (author's responsibility):
  recipe.json — id, name, transports, auth, install, metadata (author-provided hints)

Catalog overlays (catalog's responsibility):
  quality.json    — verified, badge, upstreamHash (existing, see §2.8)
  promotion.json  — promoted, affiliateUrl (existing, see §6.3)
  enrichment.json — computed/curated metadata dimensions
```

**Enrichment sources:**

| Source | Description | Example |
|--------|-------------|---------|
| **Computed from recipe** | Derived from existing recipe fields | `authSummary: "api-key"` from `auth.type` (see §3.8) |
| **AI-extracted** | LLM analyzes the recipe + README | auto-generate `subcategory`, `audience` |
| **Curated by catalog operator** | Manually assigned by AIWerk | `origin: "official"`, `countries: ["CH"]` |
| **Usage-derived** | Computed from catalog analytics | `popularityScore`, `weeklyDownloads` |

#### 3.7.3 Merge Rules

When the catalog serves a recipe (via `catalog.info` or `catalog.search`):

1. Start with the raw `recipe.json` metadata
2. Deep-merge the enrichment overlay (enrichment wins on conflict)
3. Deep-merge the quality overlay
4. Deep-merge the promotion overlay

**Recipe author hints are preserved** — if a recipe author sets `subcategory: "email"` in their recipe, and the catalog enrichment also has `subcategory: "email"`, they agree. If the catalog has a different value, the catalog overlay wins (the catalog operator is the authority for catalog-level metadata).

**Recipe authors are encouraged but not required** to include the new metadata fields. The catalog will fill in gaps automatically.

#### 3.7.4 Adding New Dimensions

To add a new metadata dimension (e.g., `authSummary`):

1. **No spec change needed** — add it to the enrichment overlay
2. **No recipe changes needed** — the catalog computes it from existing `auth` fields
3. **Backfill** — run enrichment on all existing recipes (batch job)
4. **Search/filter** — update `catalog.search` to support the new dimension
5. **Optional:** add the field to the recipe schema in the next spec revision so authors can provide hints

This means the catalog can evolve its search/filter dimensions independently of the recipe format version. Recipe authors never need to update their recipes for catalog-side improvements.

#### 3.7.5 Taxonomy Registry

The canonical list of categories, subcategories, origins, countries, and other enum values is maintained by the catalog as a **taxonomy registry**:

```
catalog.taxonomy() → {
  categories: [...],
  subcategories: { "productivity": [...], "development": [...], ... },
  origins: [...],
  audiences: [...],
  sideEffects: [...],
  countries: [...]   // ISO codes relevant to the catalog
}
```

- The bridge ships a **static snapshot** of the taxonomy (`taxonomy.json`) for offline use
- The catalog serves the **live version** via `catalog.taxonomy()`
- When both are available, the catalog version wins (it may have new entries)
- Adding a new category/subcategory = update the catalog's taxonomy, no recipe or spec changes

### 3.8 Maintainer Contact

Optional contact information for the recipe author/maintainer. Used by the catalog for security alerts, upstream update notifications, publisher verification, and community feedback.

```json
"metadata": {
  "author": "Doist",
  "maintainer": {
    "name": "Doist Engineering",
    "email": "mcp@doist.com",
    "github": "doist",
    "url": "https://doist.com"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | no | Maintainer display name (person or organization) |
| `email` | `string` | no | Contact email for security/update notifications |
| `github` | `string` | no | GitHub username or org (e.g., `doist`, `AIWerk`) |
| `url` | `string` | no | Maintainer homepage or profile URL |

At least one contact field SHOULD be provided. The `github` field is preferred as a minimum — it's less privacy-sensitive than email and enables automated PR notifications.

**Relationship to `repository`:** The top-level `repository` field (§2.2) points to the MCP server source code. The `maintainer` field identifies the *recipe* author, who may be different from the server author (e.g., AIWerk creates a recipe for a community server).

**Catalog uses:**
- Security vulnerability notifications
- Upstream version update alerts
- Publisher verification (email domain matching, GitHub org membership)
- Community feedback routing

### 3.9 Auth Summary

A convenience field that summarizes the authentication requirement in a single string. Useful for quick filtering in search results and index listings.

| `authSummary` value | Meaning |
|---------------------|---------|
| `none` | No authentication needed |
| `api-key` | Single API key/token required |
| `bearer` | Bearer token in HTTP header |
| `oauth2` | OAuth 2.0 flow required |
| `basic` | Username + password |
| `custom` | Non-standard auth (see recipe `auth.instructions`) |

**Derivation rule:** If `auth.required` is `false` or `auth` is absent → `"none"`. Otherwise use `auth.type`.

This field is a **canonical enrichment example** (see §3.7): the catalog can compute it from the existing `auth` block. Recipe authors MAY include it as a convenience; if omitted, the catalog enrichment overlay fills it in automatically.

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
| `catalog.download` | Download raw Universal Recipe for local installation |
| `catalog.list` | List/browse recipes by category/tag |
| `catalog.submit` | Submit or update a recipe (authenticated) |

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

### 7.4 CI Validation for Recipe Submissions

When recipes are submitted via pull request (e.g., to a public `mcp-recipes` repository), a CI pipeline SHOULD run multi-level validation:

#### Level 1: Schema Validation (blocking — PR cannot merge if failed)

- Recipe schema valid (all required fields present, correct types)
- URLs reachable (repository, homepage, credentialsUrl)
- `preInstall` / `postInstall` arrays empty (security policy — see §9.2)
- `id` format valid (kebab-case, 2-64 chars)
- `auth.envVars` covers all `${VAR}` references in transports (§7.1 rule 8)
- `install` block present when stdio transport is defined (§7.1 rule 9)

#### Level 2: Enrichment Consistency Warnings (non-blocking — PR can merge, but submitter is notified)

These warnings help submitters catch likely mistakes without blocking the submission:

| Warning | Trigger | Suggestion |
|---------|---------|------------|
| Country mismatch | description contains "Swiss"/"Schweiz"/"Suisse" but `countries` is `["global"]` | "Did you mean `countries: [\"CH\"]`?" |
| Auth summary mismatch | `authSummary` value doesn't match computed value from `auth.type`/`auth.required` | "authSummary says 'none' but auth.required is true" |
| Unknown subcategory | `subcategory` not in taxonomy known list | "Unknown subcategory — will be accepted but may not appear in category filters" |
| Unknown category | `category` not in taxonomy known list | Same as above |
| Tool count mismatch | `metadata.toolCount` ≠ `capabilities.toolNames.length` (when both present) | "toolCount says 27 but toolNames has 25 entries" |
| Missing contact | No `maintainer` field and no `repository` URL | "Consider adding maintainer contact for security notifications" |
| Stale verification | `metadata.lastVerified` > 90 days old | "Recipe hasn't been verified in 90+ days" |

#### Level 3: Cross-Reference Check (non-blocking)

- If `install-server.sh` exists, verify that the recipe's repository URL matches the clone URL in the install script
- If the recipe `id` already exists in the catalog, warn about potential duplicates

**Implementation:** The `validate-recipes.sh` script in the bridge repo already handles Level 1 + partial Level 3. Level 2 warnings should be added as a separate pass that outputs GitHub PR annotations (warnings, not errors).

### 7.5 Recipe Submission Methods

A public recipe repository (e.g., `awesome-mcp-recipes`) SHOULD support two submission paths to accommodate both technical and non-technical contributors:

#### Method A: Issue Template (non-technical)

A GitHub Issue Template form where the submitter fills in fields in the browser — no git/fork/JSON knowledge required:

- Server name, description, homepage
- Transport type, command, args
- Auth type, env var names, credentials URL
- Category, subcategory, countries
- Contact info (GitHub username minimum)

After submission, the issue is reviewed by a curator who creates the `recipe.json` and opens an internal PR. Optionally, a GitHub Action can auto-generate a draft `recipe.json` from the form fields.

**Advantages:** Low barrier to entry, encourages non-developer contributions (e.g., SaaS companies submitting their own server).

#### Method B: Pull Request (technical)

The submitter forks the repo, creates `recipes/<id>/recipe.json`, and opens a PR:

- Full control over the recipe content
- CI validates automatically (see §7.4)
- Faster path to merge (no curator intermediary for the recipe generation step)
- PR template reminds the submitter of required/recommended fields

**Advantages:** Direct, precise, version-controlled. Preferred for developers and repeat contributors.

Both methods result in the same outcome: a validated `recipe.json` in the repository's `recipes/` directory, followed by catalog sync.

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

- The `quality.upstreamHash` (in catalog overlay) provides static integrity verification but is NOT a substitute for code audit.
- Recipe signatures (Ed25519) are specified separately in the Catalog Security Spec.

### 9.4 Tool Manifest Hash (Runtime Integrity)

**Problem:** A signed recipe guarantees the *recipe file* was not tampered with, but not the *MCP server code* behind it. If the upstream package is compromised (same version, different code) or a `latest` tag points to a new version with unexpected behavior, the signature remains valid even though the running server has changed.

Source-specific integrity checks (npm SHA-512, Docker digest, PyPI hash) exist but require per-registry logic, don't work for hosted endpoints, and verify the *binary* rather than the *behavior*.

**Solution: `toolsHash`** — a SHA-256 hash of the canonical tool manifest returned by the MCP server's `tools/list` response at signing time.

```json
{
  "install": {
    "method": "npx",
    "package": "todoist-mcp",
    "version": "0.6.2",
    "toolsHash": "sha256-a7f3b2c9d8e1f4..."
  }
}
```

#### 9.4.1 How it works

**At signing time (publisher/catalog operator):**
1. Start the MCP server using the recipe's transport config.
2. Send a `tools/list` request.
3. Canonicalize the response: sort tools by name, sort parameters alphabetically within each tool, apply `stableStringify()` (deterministic JSON with sorted keys, no whitespace).
4. Compute: `SHA-256(canonical(tools/list response))`.
5. Store as `install.toolsHash` in the recipe.
6. Sign the recipe (the `install` field — including `toolsHash` — is part of `SIGNED_FIELDS`).

**At install/connect time (adapter/bridge):**
1. Start the MCP server.
2. Send a `tools/list` request.
3. Canonicalize and hash the response using the same algorithm.
4. Compare with `install.toolsHash` from the recipe.

#### 9.4.2 Verification outcomes

| Outcome | Meaning | Adapter behavior |
|---------|---------|-----------------|
| **Hash matches** | Server exposes exactly the tools that were audited | ✅ `Verified by <publisher>` |
| **Hash mismatch** | Tools have changed since signing (new tools, removed tools, changed params/descriptions) | ⚠️ Warning: "Tool manifest changed since verification — proceed with caution" |
| **No `toolsHash` in recipe** | Recipe was signed without tool manifest verification | ℹ️ "Signature covers recipe only, not runtime behavior" |
| **Server unreachable** | Cannot start server to verify | ⚠️ "Cannot verify tool manifest — server not running" |

#### 9.4.3 Properties

- **Source-independent:** Works for npm, pip, Docker, Go, binary, hosted HTTP — any MCP server that implements `tools/list`.
- **Behavior-oriented:** Verifies what the user/agent actually interacts with (tool names, descriptions, parameters), not binary blobs.
- **Tamper-evident:** If `toolsHash` is in the recipe and the recipe is signed, modifying either the hash or the server tools invalidates the signature.
- **Non-blocking by default:** A mismatch produces a warning, not a hard failure. Adapters MAY offer a strict mode (`--strict-integrity`) that blocks on mismatch.

#### 9.4.4 Canonicalization algorithm

```
canonical(tools_list_response) =
  stableStringify(
    tools.sort_by(name).map(tool => {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema  // sorted keys recursively
    })
  )
```

Only `name`, `description`, and `inputSchema` are included. Server-internal fields (e.g., annotations, custom metadata) are excluded to avoid false positives from non-functional changes.

#### 9.4.5 Automated Signing Workflow

The signing tool (`sign-recipe`) SHOULD automate the full integrity chain in a single invocation:

```
Input:  unsigned recipe with "version": "latest"
Output: signed recipe with pinned version + toolsHash + Ed25519 signature
```

**Steps performed automatically:**

1. **Version resolution:** If `install.version` is `"latest"` (or missing), query the package registry (npm, PyPI) for the current stable version. Replace `"latest"` with the resolved semver (e.g., `"0.6.2"`). Also update `transports[].args` if they contain `@latest` (e.g., `"todoist-mcp@latest"` → `"todoist-mcp@0.6.2"`).

2. **Tool manifest capture:** Start the MCP server using the recipe's transport config (stdio: spawn the command; SSE/HTTP: connect to the endpoint). Send `tools/list`, canonicalize and hash the response. Store as `install.toolsHash`.

3. **Validation:** Run the recipe validator (§7) on the updated recipe. Abort if errors are found.

4. **Signing:** Compute the Ed25519 signature over `SIGNED_FIELDS` (which now includes the pinned version and `toolsHash` via the `install` field).

5. **Output:** Write the signed recipe with all fields updated in-place.

**CLI interface:**

```bash
# Sign a single recipe (auto-resolve version + compute toolsHash):
sign-recipe servers/todoist/recipe.json --output servers/todoist/recipe.json

# Sign all recipes in a directory:
sign-recipe --all servers/ --output-dir servers/

# Dry run (show what would change without writing):
sign-recipe servers/todoist/recipe.json --dry-run
```

**Environment requirements for toolsHash:**
- For stdio servers: the signing machine must have the runtime installed (Node.js, Python, etc.)
- For servers requiring API keys: either provide dummy keys (if the server exposes tools without auth) or set the required env vars. Many MCP servers expose their tool list without valid credentials.
- If the server cannot be started (missing deps, auth required), `toolsHash` is omitted and a warning is emitted.

#### 9.4.6 Limitations

- **Dynamic tools:** Some MCP servers register tools dynamically based on configuration or auth state. For these servers, `toolsHash` should be computed in a well-defined default configuration.
- **Hosted endpoints (SSE/HTTP):** The hash can be computed for remote servers too — the adapter connects and verifies `tools/list` at connect time. However, the server operator can change behavior at any time between connections.
- **Not a code audit:** A matching `toolsHash` means "same tools as when signed" — it does not guarantee the tool implementations are safe.

## 10. Cost & Rate Limiting

### 10.1 Problem

MCP servers that wrap paid APIs (Google Maps, Stripe, OpenAI, etc.) can generate unbounded costs when an AI agent makes excessive tool calls. Neither the agent, the LLM, nor the MCP server typically enforce spending limits. The bridge is the **only enforcement point** in the call chain.

Real-world incident: Google Maps MCP server made 56,000 Text Search API calls in a single day → 1,615 CHF unexpected bill.

### 10.2 Rate Limit (primary protection)

Rate limits cap the **number of tool calls** per time window, regardless of cost. This is the primary protection because it is always accurate — it does not depend on pricing data that may be outdated.

#### Recipe-level suggested limits

Recipes MAY include suggested rate limits in the `metadata` field:

```json
"metadata": {
  "pricing": "byok",
  "rateLimit": {
    "suggestedDailyLimit": 100,
    "suggestedMonthlyLimit": 2000
  }
}
```

These are **recommendations from the recipe author**, not hard limits. The adapter applies them as defaults unless the user overrides.

#### User-level overrides

Users configure limits in their bridge config or via CLI:

```bash
# Set daily limit
mcp-bridge limit google-maps --daily 50

# Set monthly limit
mcp-bridge limit google-maps --monthly 1000

# Remove limit (unlimited)
mcp-bridge limit google-maps --daily 0

# View current usage
mcp-bridge usage
```

#### Adapter behavior

| Event | Adapter action |
|-------|---------------|
| **Tool call within limit** | Allow call, increment counter |
| **80% of limit reached** | Include warning in tool response: `⚠️ google-maps: 80% of daily limit used (40/50). Adjust with: mcp-bridge limit google-maps --daily <number>` |
| **Limit reached** | Block call, return error with actionable message: `❌ Rate limit reached for google-maps: 50/50 daily calls used. Resets at midnight UTC. To adjust: mcp-bridge limit google-maps --daily 100. To check usage: mcp-bridge usage. To disable limit: mcp-bridge limit google-maps --daily 0` |
| **Server installed with suggested limit** | Display at install time: `ℹ️ Suggested daily limit: 100 calls (~$3.20/day). Adjust with: mcp-bridge limit google-maps --daily <number>` |

**Key UX principle:** Every limit notification MUST include the concrete CLI command to adjust the limit. The user should never need to search documentation to change settings.

#### Counter persistence

- Counters are stored in `~/.mcp-bridge/usage/<server-id>.json`
- Daily counters reset at midnight UTC
- Monthly counters reset on the 1st of each month at midnight UTC
- Format: `{ "daily": { "date": "2026-03-20", "count": 47 }, "monthly": { "month": "2026-03", "count": 823 } }`

### 10.3 Cost Limit (supplementary protection)

Cost limits use `costPerCall` from the recipe metadata to estimate spending. This is **supplementary** because pricing data may be outdated if the upstream API changes prices.

```json
"metadata": {
  "costPerCall": 0.032,
  "costCurrency": "USD"
}
```

#### User configuration

```bash
mcp-bridge budget google-maps --daily 5.00 --monthly 50.00
```

#### Staleness warning

If the recipe's `signature.signedAt` is older than 60 days, the adapter SHOULD warn:
```
⚠️ Recipe pricing data for google-maps is 67 days old. 
   Actual API costs may have changed. Rate limits (call count) remain accurate.
```

### 10.4 Priority of limits

When multiple limits are configured, the **most restrictive** applies:

```
1. User rate limit (calls/day)      ← always accurate
2. User budget limit ($/day)        ← depends on costPerCall accuracy
3. Recipe suggested limit           ← default if user hasn't configured
4. No limit                         ← if nothing configured
```

## 11. Future Work (deferred from v2.0)

The following topics are recognized as valuable but intentionally deferred. They will be addressed in future spec revisions when real-world usage provides clearer requirements.

### 11.1 Capability Registry (v2.1+)

For advanced smart routing and agent-driven discovery, recipes may need richer tool metadata beyond `toolExamples`:

- **Operation types:** `read`, `write`, `search`, `execute`
- **Side effects:** `none`, `external-write`, `billing-impact`
- **Input shape hints:** accepts geo coordinates, free text, file/blob, structured data
- **Supported domains:** CRM, e-commerce, DevOps, etc.

This would transform the catalog from a curated app directory into a runtime-usable capability registry. Deferred because the schema needs to be driven by actual smart routing implementation, not speculation.

### 11.2 Runtime Execution Hints (v2.1+)

Some server properties affect how a bridge runtime should manage them:

- **Stateless vs. stateful** process (can it be restarted freely?)
- **Singleton vs. concurrent-safe** (can multiple instances run?)
- **Long-running background** vs. on-demand spawn
- **Idempotency hints** per tool
- **Server-level timeout overrides** (startup, request)

These are bridge runtime concerns (see §1.1.1) but could benefit from recipe-level hints. Deferred until the bridge runtime spec matures.

### 11.3 Enhanced Adapter Override Mechanism (v2.1+)

The current array-replace merge semantics (§4.5) are simple but blunt. A future revision may introduce:

- JSON Patch (RFC 6902) support for fine-grained overrides
- Conditional overrides (e.g., "if Docker available, use this transport")
- Platform-conditional overrides beyond `install.platforms`

Deferred because the current model covers all existing recipes without issues.

### 11.4 Full OAuth2 Integration Spec

A standalone spec for OAuth2 credential bootstrap, token storage, and refresh across adapters. See §2.5.1.

### 11.5 Auto-Discovery (v2.8+)

**Problem:** Users must manually add server entries to their bridge config even when a recipe exists and the required env vars are already set. This is unnecessary friction.

**Solution:** The bridge scans its **local recipe cache** (populated from the catalog) at startup (and on `refresh`) and automatically registers servers whose required credentials are available — no config entry needed.

#### 11.5.1 Discovery Flow

```
Bridge startup / refresh
    │
    ├── Scan local cache: recipes/*/recipe.json
    │
    ├── For each recipe:
    │   ├── Read auth.envVars[]
    │   ├── Check each var against .env + process.env
    │   │
    │   ├── ALL vars present?
    │   │   └── YES → Add to router as auto-discovered server
    │   │           (runtime only, no config file modification)
    │   │
    │   └── SOME or NONE present?
    │       └── Mark as "available" with missing var list
    │
    └── Merge with manually configured servers
        (manual config takes priority on conflict)
```

#### 11.5.2 Server Categories

| Category | Example | Auto-discovery behavior |
|----------|---------|------------------------|
| API key + stdio | tavily, github, notion | ✅ env var check → auto register |
| No auth required | chrome-devtools | ✅ always available |
| Bearer + HTTP | apify (streamable-http) | ✅ env var check → auto register |
| Multi env var | atlassian (6 vars), imap (7 vars) | ✅ ALL required, partial = "available" |

#### 11.5.3 Status Reporting

`mcp(action="status")` extended output:

```json
{
  "servers": {
    "tavily": { "status": "connected", "source": "auto-discovered" },
    "github": { "status": "connected", "source": "config" },
    "firecrawl": {
      "status": "available",
      "source": "auto-discovery",
      "missing": ["FIRECRAWL_API_KEY"],
      "credentialsUrl": "https://firecrawl.dev/account"
    },
    "atlassian": {
      "status": "available",
      "source": "auto-discovery",
      "missing": ["JIRA_URL", "JIRA_USERNAME", "JIRA_API_TOKEN"],
      "credentialsUrl": "https://id.atlassian.com/manage-profile/security/api-tokens"
    }
  }
}
```

#### 11.5.4 Configuration

```json
{
  "autoDiscovery": {
    "enabled": true,
    "recipesCacheDir": "recipes/",
    "allowList": null,
    "denyList": []
  }
}
```

- **`enabled`** (default: `true`): Toggle auto-discovery on/off.
- **`recipesCacheDir`** (default: `"recipes/"`): Path to scan for cached recipes. Relative to bridge data directory.
- **`allowList`** (default: `null`): If set, only these server IDs are auto-discovered. `null` = allow all.
- **`denyList`** (default: `[]`): Server IDs to exclude from auto-discovery.

#### 11.5.5 Priority Rules

1. **Manual config always wins.** If a server is both manually configured and auto-discoverable, the manual config is used.
2. **No config file modification.** Auto-discovered servers exist only in runtime memory.
3. **Refresh clears and re-scans.** `mcp(action="refresh")` triggers a full re-scan.

#### 11.5.6 Transport Selection

For auto-discovered servers, the bridge uses the **first** transport entry in the recipe's `transports[]` array (matching the static selection rule in §3.2). Adapter overrides (§4) are not applied — auto-discovery uses the recipe defaults.

#### 11.5.7 Implementation Notes

- **Core (`mcp-bridge`)**: `autoDiscovery()` function that scans recipes + checks env vars → returns `{ ready: ServerConfig[], available: AvailableServer[] }`
- **Adapter layer**: Each adapter can call `autoDiscovery()` and merge results with its native config format.
- **Security**: New recipes added via catalog sync / bootstrap may become automatically active if env vars are set. The `denyList` config provides opt-out control.
- **Bootstrap**: On first run, the bridge MAY prefetch the top 10–15 most popular catalog entries into the local cache for offline readiness.

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
