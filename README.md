# @aiwerk/mcp-bridge

[![CI](https://github.com/AIWerk/mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/AIWerk/mcp-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@aiwerk/mcp-bridge.svg)](https://www.npmjs.com/package/@aiwerk/mcp-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Your AI, Connected to Everything.** Multiplex multiple MCP servers into one interface. One config, one connection, all your tools.

🌐 **[aiwerkmcp.com](https://aiwerkmcp.com)** — Learn more about the AIWerk MCP Platform

Works with **Claude Code**, **Codex (OpenAI)**, **Claude Desktop**, **Cursor**, **Windsurf**, **Cline**, **OpenClaw**, or any MCP client.

## Why?

Most AI agents connect to MCP servers one-by-one. With 10+ servers, that's 10+ connections, 200+ tools in context, and thousands of wasted tokens.

**MCP Bridge** solves this:
- **Router mode**: all servers behind one `mcp` meta-tool (~99% token reduction)
- **Intent routing**: say what you need in plain language, the bridge finds the right tool
- **Schema compression**: tool descriptions compressed ~57%, full schema on demand
- **Security layer**: trust levels, tool deny/allow lists, result size limits
- **HTTP auth**: bearer token, custom headers, **OAuth2 Client Credentials**, and **OAuth2 Authorization Code + PKCE** (interactive browser login)
- **Result caching**: LRU cache with per-tool TTL overrides
- **Batch calls**: parallel multi-tool execution via `action=batch`
- **Multi-server resolution**: automatic tool disambiguation when multiple servers provide the same tool
- **Configurable retries**: exponential backoff for transient errors
- **Graceful shutdown**: clean process termination and connection cleanup
- **Direct mode**: all tools registered individually with automatic prefixing
- **3 transports**: stdio, SSE, streamable-http
- **Built-in catalog**: 14 pre-configured servers, install with one command (bundled servers deprecated — use [MCP Catalog](https://catalog.aiwerk.ch) with 104+ recipes instead)
- **Zero config secrets in files**: `${ENV_VAR}` resolution from `.env`

## Install

```bash
npm install -g @aiwerk/mcp-bridge
```

## Quick Start

```bash
# 1. Initialize config and register with Claude Code
mcp-bridge init --register claude-code

# 2. Install a server from the catalog
mcp-bridge install todoist

# 3. Add your API key
echo "TODOIST_API_TOKEN=your-token" >> ~/.mcp-bridge/.env

# 4. Restart Claude Code — bridge is ready
```

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "mcp-bridge",
      "args": []
    }
  }
}
```

## Recipe Spec v2

Bundled servers now ship with `recipe.json` using **Universal Recipe Spec v2.1** (15 servers with rich metadata: category, subcategory, origin, countries, audience, sideEffects).
During install, MCP Bridge prefers `recipe.json` when present and falls back to legacy `config.json` (v1) for backwards compatibility.

- Spec: [`docs/universal-recipe-spec.md`](docs/universal-recipe-spec.md)
- Runtime compatibility: v1 and v2 are both supported
- Existing v1-only servers continue to work unchanged

For third-party recipe authors:

1. Author `recipe.json` per the spec above.
2. Validate your recipe before publishing:

```bash
npx @aiwerk/mcp-bridge validate-recipe ./recipe.json
```

`config.json` (v1) remains supported, but `recipe.json` (v2) is the recommended format going forward.

## Catalog Integration (v2.8.0+)

mcp-bridge now fetches recipes from [catalog.aiwerk.ch](https://catalog.aiwerk.ch) instead of relying on bundled recipe files.

### How it works
1. **First run**: Automatically downloads the top 15 most popular recipes
2. **On-demand**: When you install a server, it checks the catalog first
3. **Offline**: Falls back to local cache if catalog is unreachable

### API
```typescript
import { CatalogClient, bootstrapCatalog, mergeRecipesIntoConfig } from '@aiwerk/mcp-bridge';

// Bootstrap: download top recipes
await bootstrapCatalog();

// Or use the client directly
const client = new CatalogClient();
const recipe = await client.resolve('todoist');
const results = await client.search('email');
```

### Catalog & Auto-Merge Options

Two config options control catalog behavior:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `catalog` | `boolean` | `true` | Whether `bootstrapCatalog()` fetches recipes from the remote catalog |
| `autoMerge` | `boolean` | `false` | Whether `mergeRecipesIntoConfig()` auto-merges cached recipes into your config |

```json
{
  "catalog": true,
  "autoMerge": true,
  "servers": { ... }
}
```

- **`autoMerge` defaults to `false`** (opt-in) — cached recipes are **not** automatically added to your server list unless you explicitly enable it. This prevents servers without required credentials from being silently activated.
- **`catalog` defaults to `true`** — recipe discovery from [catalog.aiwerk.ch](https://catalog.aiwerk.ch) is enabled by default. Set to `false` to skip all remote fetching.

> **Breaking change (v2.9.0):** Previously, all cached recipes whose env vars were present were auto-merged. Now you must set `"autoMerge": true` to restore that behavior.

### Multiple instances of the same server

Auto-discovery uses the recipe name as the config key (e.g., `gohighlevel`). If you need **multiple instances** of the same server with different credentials (e.g., two GoHighLevel subaccounts), configure them manually:

```json
// config.json or openclaw.json
{
  "ghl-client-a": {
    "transport": "streamable-http",
    "url": "https://services.leadconnectorhq.com/mcp/",
    "headers": {
      "Authorization": "Bearer ${GHL_TOKEN_A}",
      "locationId": "${GHL_LOCATION_A}"
    }
  },
  "ghl-client-b": {
    "transport": "streamable-http",
    "url": "https://services.leadconnectorhq.com/mcp/",
    "headers": {
      "Authorization": "Bearer ${GHL_TOKEN_B}",
      "locationId": "${GHL_LOCATION_B}"
    }
  }
}
```

Use **unique env var names** (e.g., `GHL_TOKEN_A` instead of `GHL_PIT_TOKEN`) to prevent auto-discovery from adding a duplicate third entry. Manual config always takes priority over auto-discovered recipes.

> **Note**: The bundled `servers/` directory is deprecated and will be removed in v3.0.0.

## Use with Cursor / Windsurf

Add to your MCP config:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "mcp-bridge",
      "args": ["--config", "/path/to/config.json"]
    }
  }
}
```

## Use with OpenClaw

Install as a plugin (handles everything automatically):

```bash
openclaw plugins install @aiwerk/openclaw-mcp-bridge
```

> ⚠️ **Important:** Always use the full scoped name `@aiwerk/openclaw-mcp-bridge`. The unscoped `openclaw-mcp-bridge` on npm is a **different, unrelated package**.

See [@aiwerk/openclaw-mcp-bridge](https://github.com/AIWerk/openclaw-mcp-bridge) for details.

## Configuration

Config: `~/.mcp-bridge/config.json` | Secrets: `~/.mcp-bridge/.env`

```json
{
  "mode": "router",
  "servers": {
    "todoist": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@doist/todoist-ai"],
      "env": { "TODOIST_API_KEY": "${TODOIST_API_TOKEN}" },
      "description": "Task management"
    },
    "github": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" },
      "description": "GitHub repos, issues, PRs"
    },
    "notion": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-notion"],
      "env": { "NOTION_API_KEY": "${NOTION_TOKEN}" },
      "description": "Notion pages and databases"
    }
  },
  "toolPrefix": true,
  "connectionTimeoutMs": 5000,
  "requestTimeoutMs": 60000,
  "maxBatchSize": 10,
  "schemaCompression": {
    "enabled": true,
    "maxDescriptionLength": 80
  }
}
```

### Schema Compression

In router mode, tool descriptions from upstream servers can be verbose (100-300+ chars each). Schema compression truncates them to save tokens:

- **Enabled by default** — descriptions capped at 80 characters
- Cuts at sentence boundary when possible, otherwise word boundary
- Use `action=schema` to retrieve the full uncompressed schema for any tool on demand

```json
"schemaCompression": {
  "enabled": true,
  "maxDescriptionLength": 80
}
```

**Token savings example:** 30 Todoist tools: ~2800 tokens uncompressed -> ~1200 compressed (~57% reduction).

To get full details for a specific tool:
```
mcp(server="todoist", action="schema", tool="find-tasks")
```

Set `"enabled": false` to disable compression and return full descriptions.

### Result Caching

Router mode can cache successful `action=call` tool results in memory using an LRU policy.

- Disabled by default (`resultCache.enabled: false`)
- No external dependencies (Map-based implementation)
- Defaults: `maxEntries: 100`, `defaultTtlMs: 300000` (5 minutes)
- Cache key: `server:tool:stableJson(params)`
- Per-tool TTL override via `resultCache.cacheTtl` (for example `"todoist:find-tasks": 60000`)
- `action=refresh` clears the result cache
- Error responses are never cached

```json
"resultCache": {
  "enabled": true,
  "maxEntries": 100,
  "defaultTtlMs": 300000,
  "cacheTtl": { "todoist:find-tasks": 60000 }
}
```

### Intent Routing

Instead of specifying the exact server and tool, describe what you need:

```
mcp(action="intent", intent="find my tasks for today")
```

The bridge uses vector embeddings to match your intent to the right server and tool automatically. Returns the best match with a confidence score and alternatives.

**Embedding providers** (configured via `intentRouting.embedding`):

| Provider | Config | Requires |
|----------|--------|----------|
| `gemini` (default for auto) | `GEMINI_API_KEY` in `.env` | Free tier available |
| `openai` | `OPENAI_API_KEY` in `.env` | Paid API |
| `ollama` | Local Ollama running | No API key |
| `keyword` | Nothing | Offline fallback, less accurate |

```json
"intentRouting": {
  "embedding": "auto",
  "minScore": 0.3
}
```

- `auto` (default): tries gemini, openai, ollama, then keyword - in order of availability
- `minScore`: minimum confidence to return a match (0-1, default: 0.3)
- Index is built lazily on first `action=intent` call

### Batch Calls

Run multiple tool calls in one round-trip with `action="batch"` (parallel execution):

```json
{"action":"batch","calls":[{"server":"todoist","tool":"find-tasks","params":{"query":"today"}},{"server":"github","tool":"list_repos","params":{}}]}
```

```json
{"action":"batch","results":[{"server":"todoist","tool":"find-tasks","result":{"tasks":[]}}, {"server":"github","tool":"list_repos","error":{"error":"mcp_error","message":"..."}}]}
```

Use `maxBatchSize` in config to cap requests (default: `10`). Failed calls return per-slot `error` while successful calls still return `result`.

### Security

Three layers of protection for tool results:

#### Trust Levels

Per-server control over how results are passed to the agent:

```json
"servers": {
  "my-trusted-server": {
    "trust": "trusted"
  },
  "unknown-server": {
    "trust": "untrusted"
  },
  "sketchy-server": {
    "trust": "sanitize"
  }
}
```

| Level | Behavior |
|-------|----------|
| `trusted` (default) | Results pass through as-is |
| `untrusted` | Results tagged with `_trust: "untrusted"` metadata |
| `sanitize` | HTML tags stripped, known prompt injection patterns removed (**best-effort** — see note below) |

#### Tool Filter

Control which tools are visible and callable per server:

```json
"servers": {
  "github": {
    "toolFilter": {
      "deny": ["delete_repository"],
      "allow": ["list_repos", "create_issue", "search_code"]
    }
  }
}
```

- `deny`: block specific dangerous tools
- `allow`: whitelist mode - only these tools are visible
- If both: allowed tools minus denied ones
- Applied in both tool listing and execution (defense in depth)

#### Max Result Size

Prevent oversized responses from consuming your context:

```json
{
  "maxResultChars": 50000,
  "servers": {
    "verbose-server": {
      "maxResultChars": 10000
    }
  }
}
```

- Global default + per-server override
- Truncated results include `_truncated: true` and `_originalLength`

### Adaptive Promotion

Frequently used tools can be automatically "promoted" to standalone tools alongside the `mcp` meta-tool. The promotion system tracks usage and reports which tools qualify — the host environment (e.g., OpenClaw plugin) decides how to register them.

```json
"adaptivePromotion": {
  "enabled": true,
  "maxPromoted": 10,
  "minCalls": 3,
  "windowMs": 86400000,
  "decayMs": 172800000
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Opt-in: must be explicitly enabled |
| `maxPromoted` | `10` | Maximum number of tools to promote |
| `minCalls` | `3` | Minimum calls within window to qualify |
| `windowMs` | `86400000` (24h) | Time window for counting calls |
| `decayMs` | `172800000` (48h) | Demote tools with no calls in this period |

Use `action="promotions"` to check current promotion state:
```
mcp(action="promotions")
```

Returns promoted tools (sorted by frequency) and full usage stats. All tracking is in-memory — promotion rebuilds naturally from usage after restart.

### Modes

| Mode | Tools exposed | Best for |
|------|--------------|----------|
| `router` (default) | Single `mcp` meta-tool | 3+ servers, token-conscious agents |
| `direct` | All tools individually | Few servers, simple agents |

**Router mode** — the agent calls `mcp(server="todoist", action="list")` to discover, then `mcp(server="todoist", tool="find-tasks", params={...})` to execute.

### Multi-Server Tool Resolution

When `action="call"` is used without `server=`, mcp-bridge can resolve collisions automatically.

- Tool exists on exactly one server → direct dispatch.
- Tool exists on multiple servers + explicit `server=` → explicit target wins.
- Tool exists on multiple servers + no `server=` → score each candidate:
  - **base_priority**: reverse config order (`last=1.0`, then `0.9`, `0.8`, floor `0.1`)
  - **recency_boost**: `+0.3` if server used in last 5 successful calls
  - **param_match**: up to `+0.2` based on parameter-name overlap with input schema
- If top score gap is `>= 0.15` → auto-dispatch to the winner.
- If top score gap is `< 0.15` → return normal `{ ambiguous: true, candidates: [...] }` response.

**Direct mode** — tools are registered as `todoist_find_tasks`, `github_list_repos`, etc.

### Transports

| Transport | Config key | Use case |
|-----------|-----------|----------|
| `stdio` | `command`, `args` | Local CLI servers (most common) |
| `sse` | `url`, `headers` | Remote SSE servers |
| `streamable-http` | `url`, `headers` | Modern HTTP-based servers |

### Authentication

SSE and streamable-HTTP transports support three auth methods:

**Bearer token:**
```json
{ "auth": { "type": "bearer", "token": "${MY_API_TOKEN}" } }
```

**Custom headers:**
```json
{ "auth": { "type": "header", "headers": { "X-API-Key": "${MY_KEY}" } } }
```

**OAuth2 Client Credentials** (automatic token management):
```json
{
  "auth": {
    "type": "oauth2",
    "clientId": "${CLIENT_ID}",
    "clientSecret": "${CLIENT_SECRET}",
    "tokenUrl": "https://provider.com/oauth/token",
    "scopes": ["read", "write"]
  }
}
```

OAuth2 features: automatic token acquisition, caching with expiry-aware refresh, single-attempt 401 retry, env var substitution in credentials.

**OAuth2 Authorization Code + PKCE** (interactive browser login):

For MCP servers behind enterprise SSO or user-level OAuth2 that require browser-based login (desktop/laptop):

```json
{
  "auth": {
    "type": "oauth2",
    "grantType": "authorization_code",
    "authorizationUrl": "https://auth.example.com/authorize",
    "tokenUrl": "https://auth.example.com/oauth/token",
    "clientId": "optional-public-client-id",
    "scopes": ["read", "write"]
  }
}
```

Then authenticate via CLI:

```bash
mcp-bridge auth login my-server    # Opens browser, completes OAuth2 flow
mcp-bridge auth status             # Check token status for all servers
mcp-bridge auth logout my-server   # Remove stored token
```

Features:
- **PKCE (RFC 7636)** — mandatory S256 code challenge, no `clientSecret` needed for public clients
- **Persistent tokens** — stored in `~/.mcp-bridge/tokens/` (chmod 600), survive bridge restarts
- **Automatic refresh** — tokens refreshed transparently via `refresh_token` grant
- **Actionable errors** — expired tokens return error with exact CLI command to re-authenticate

**OAuth2 Device Code** (headless environments — VPS, Docker, SSH, CI):

For environments without a browser. You authenticate on a separate device using a short code:

```json
{
  "auth": {
    "type": "oauth2",
    "grantType": "device_code",
    "deviceAuthorizationUrl": "https://github.com/login/device/code",
    "tokenUrl": "https://github.com/login/oauth/access_token",
    "clientId": "your-app-id",
    "scopes": ["repo", "read:org"]
  }
}
```

```bash
mcp-bridge auth login my-server
# ──────────────────────────────────────────
#  Device authentication for "my-server"
#
#  1. Open: https://github.com/login/device
#  2. Enter code: ABCD-1234
# ──────────────────────────────────────────
# Waiting for authorization...
```

Features:
- **RFC 8628 compliant** — works with GitHub, Google, Microsoft, Auth0, Okta
- **No local browser needed** — authenticate from phone/laptop, token received on server
- **Automatic polling** — respects `interval` and `slow_down` responses
- **Same token persistence** — stored in `~/.mcp-bridge/tokens/` with auto-refresh

### Environment variables

Secrets go in `~/.mcp-bridge/.env` (chmod 600 on init):

```
TODOIST_API_TOKEN=your-token-here
GITHUB_TOKEN=ghp_xxxxx
NOTION_TOKEN=ntn_xxxxx
```

Use `${VAR_NAME}` in config — resolved from `.env` + system env.

## CLI Reference

```bash
mcp-bridge                        # Start in stdio mode (default)
mcp-bridge --sse --port 3000      # Start as SSE server
mcp-bridge --http --port 3000     # Start as HTTP server
mcp-bridge --verbose              # Info-level logs to stderr
mcp-bridge --debug                # Full debug metadata in tool responses
mcp-bridge --config ./my.json     # Custom config file

mcp-bridge init                   # Create ~/.mcp-bridge/ with template config
mcp-bridge init --register claude-code  # Init + register with Claude Code
mcp-bridge init --register codex        # Init + register with Codex
mcp-bridge init --register cursor       # Init + register with Cursor
mcp-bridge init --register windsurf     # Init + register with Windsurf
mcp-bridge install <server>       # Install from online catalog
mcp-bridge catalog                # Browse 100+ available servers
mcp-bridge servers                # List configured servers
mcp-bridge search <query>         # Search catalog by keyword
mcp-bridge update [--check]       # Check for / install updates
mcp-bridge --version              # Print version

mcp-bridge auth login <server>    # OAuth2 browser login (Authorization Code + PKCE)
mcp-bridge auth logout <server>   # Remove stored token
mcp-bridge auth status            # Show auth status for all servers
```

## Agent Integration

When connected to an MCP client (Claude Code, Codex, Cursor, etc.), the bridge exposes a single `mcp` meta-tool. Agents can discover and install servers at runtime:

```
mcp(action="search", params={query: "task management"})  # Search catalog
mcp(action="install", params={name: "todoist"})           # Install server (persisted to config)
mcp(action="catalog")                                      # Browse all servers
mcp(action="list", server="todoist")                       # Discover tools on a server
mcp(action="call", server="todoist", tool="find-tasks", params={query: "today"})
```

The tool description automatically includes all connected servers with their descriptions, so agents know which server to use for what. New servers installed via the bridge are persisted to `~/.mcp-bridge/config.json` and survive restarts.

## Server Catalog

Browse and install from the [AIWerk MCP Catalog](https://catalog.aiwerk.ch) with 100+ verified, signed recipes:

```bash
mcp-bridge catalog                # Browse all 100+ servers
mcp-bridge search payments        # Search by keyword
mcp-bridge install todoist        # Install from catalog
```

Popular servers include: todoist, github, notion, stripe, linear, google-maps, slack, supabase, mongodb, playwright, docker, and many more.

All catalog recipes are Ed25519 signed and security-audited. The bridge verifies signatures before installation.

> **Note**: The bundled `servers/` directory is deprecated. All servers now come from the online catalog.

## Library Usage

Use as a dependency in your own MCP server or OpenClaw plugin:

```typescript
import { McpRouter, StandaloneServer, loadConfig } from "@aiwerk/mcp-bridge";

// Quick start
const config = loadConfig({ configPath: "./config.json" });
const server = new StandaloneServer(config, console);
await server.startStdio();
```

```typescript
// Use the router directly
import { McpRouter } from "@aiwerk/mcp-bridge";

const router = new McpRouter(servers, config, logger);
const result = await router.dispatch("todoist", "call", "find-tasks", { query: "today" });
```

## Architecture

```
┌─────────────────┐     ┌──────────────────────────────────────────────┐
│  Claude Desktop  │     │  MCP Bridge                                  │
│  Cursor          │◄───►│                                              │
│  Windsurf        │stdio│  ┌──────────┐  ┌────────┐  ┌────────────┐  │
│  OpenClaw        │ SSE │  │  Router   │  │Security│  │  Backend   │  │
│  Any MCP client  │ HTTP│  │  Intent   │─►│ Trust  │─►│  servers:  │  │
└─────────────────┘     │  │  Schema   │  │ Filter │  │  • todoist │  │
                        │  │  Compress │  │ Limit  │  │  • github  │  │
                        │  └──────────┘  └────────┘  │  • notion  │  │
                        │                            │  • stripe  │  │
                        │                            └────────────┘  │
                        └──────────────────────────────────────────────┘
```

## Security Limitations

The built-in security layer (trust levels, tool filters, result sanitization) provides **best-effort baseline protection** for common threats:

- Prompt injection patterns (known strings — regex-based)
- Oversized responses (JSON-aware truncation)
- Unauthorized tool access (tool deny/allow lists)

> ⚠️ **`trust: "sanitize"` is NOT a security boundary.** It catches common/known injection patterns but is trivially bypassable via Unicode homoglyphs, zero-width characters, base64 encoding, or multi-step injection chains. Treat it as defense-in-depth, not a sole protection layer.

**What it does NOT cover:**
- Unicode obfuscation / homoglyph attacks
- Sophisticated multi-step injection chains
- Content-level PII detection
- Base64 or otherwise encoded payloads

For production deployments with high security requirements, consider adding an external content filtering layer (e.g., guardrails, PII redaction service) between the bridge and your application.

## Roadmap

| Status | Feature | Version |
|--------|---------|---------|
| ✅ | Smart Router v2 (intent, cache, batch, resolution) | 1.9.0 |
| ✅ | HTTP auth (bearer, headers) | 2.0.0 |
| ✅ | Configurable retries + graceful shutdown | 2.0.0 |
| ✅ | OAuth2 Client Credentials | 2.1.0 |
| ✅ | OAuth2 Authorization Code + PKCE | 2.5.0 |
| ✅ | OAuth2 Device Code flow (headless) | 2.6.0 |
| ✅ | Agent-driven discovery (search/install at runtime) | 2.8.6 |
| 🔜 | Hosted bridge (bridge.aiwerk.ch) | planned |
| ✅ | Remote catalog integration | 2.8.0 |
| ✅ | CLI online catalog | 2.8.23 |
| ✅ | Debug mode (_debug metadata) | 2.8.4 |
| 🔜 | OpenTelemetry / Prometheus metrics | planned |
| 🔜 | PII redaction | planned |
| 🔜 | Skill system (recipe.json skills for agents) | planned |

See [docs/hosted-bridge-spec.md](docs/hosted-bridge-spec.md) for the hosted bridge architecture.

## Related

- **[@aiwerk/openclaw-mcp-bridge](https://github.com/AIWerk/openclaw-mcp-bridge)** — OpenClaw plugin wrapper (uses this package as core)
- **[MCP Specification](https://spec.modelcontextprotocol.io)** — Model Context Protocol spec
- **[Awesome MCP Servers](https://github.com/punkpeye/awesome-mcp-servers)** — Community server directory

## License

MIT — [AIWerk](https://aiwerk.ch)
